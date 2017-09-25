'use strict'

const uuid = require('uuid4')
const crypto = require('crypto')
const base64url = require('base64url')

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert
const expect = chai.expect
const btpPacket = require('btp-packet')
const ilpPacket = require('ilp-packet')

const { ilpAndCustomToProtocolData } =
  require('../src/util/protocolDataConverter')
const ObjStore = require('./helpers/objStore')
const MockSocket = require('./helpers/mockSocket')
const PluginPaymentChannel = require('..')

const info = {
  prefix: 'example.red.',
  currencyCode: 'USD',
  currencyScale: 2,
  connectors: [ { id: 'other', name: 'other', connector: 'peer.usd.other' } ]
}

const peerAddress = 'example.red.client'
const options = {
  prefix: 'example.red.',
  maxBalance: '10',
  server: 'btp+wss://user:placeholder@example.com/rpc',
  info: info
}

describe('Conditional Transfers', () => {
  beforeEach(function * () {
    options._store = new ObjStore()
    this.plugin = new PluginPaymentChannel(options)

    this.fulfillment = 'gHJ2QeIZpstXaGZVCSq4d3vkrMSChNYKriefys3KMtI'
    const hash = crypto.createHash('sha256')
    hash.update(this.fulfillment, 'base64')
    this.condition = base64url(hash.digest())

    const expiry = new Date()
    expiry.setSeconds(expiry.getSeconds() + 5)

    this.transferJson = {
      id: uuid(),
      ledger: this.plugin.getInfo().prefix,
      from: this.plugin.getAccount(),
      to: peerAddress,
      amount: '5.0',
      data: {
        field: 'some stuff'
      },
      executionCondition: this.condition,
      expiresAt: expiry.toISOString()
    }
    const requestId = 12345
    this.transfer = btpPacket.serializePrepare(
      Object.assign({}, this.transferJson, {transferId: this.transferJson.id}),
      requestId,
      ilpAndCustomToProtocolData(this.transferJson)
    )

    this.btpFulfillment = btpPacket.serializeFulfill({
      transferId: this.transferJson.id,
      fulfillment: this.fulfillment
    }, requestId + 1, [])

    this.incomingTransferJson = Object.assign({}, this.transferJson, {
      from: peerAddress,
      to: this.plugin.getAccount()
    })
    this.incomingTransfer = btpPacket.serializePrepare(
      Object.assign({}, this.incomingTransferJson, {transferId: this.incomingTransferJson.id}),
      requestId + 2,
      ilpAndCustomToProtocolData(this.incomingTransferJson)
    )

    this.mockSocketIndex = 0
    this.mockSocket = new MockSocket()
    this.mockSocket
      .reply(btpPacket.TYPE_MESSAGE, ({ requestId }) => btpPacket.serializeResponse(requestId, []))

    yield this.plugin.addSocket(this.mockSocket, { username: 'user', token: 'placeholder' })
    yield this.plugin.connect()
  })

  afterEach(function * () {
    assert(yield this.mockSocket.isDone(), 'response handlers must be called')
  })

  describe('sendTransfer (conditional)', () => {
    it('allows an outgoing transfer to be fulfilled', function * () {
      this.mockSocket.reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = btpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)
        return btpPacket.serializeResponse(requestId, [])
      })

      const sent = new Promise((resolve) => this.plugin.on('outgoing_prepare', resolve))
      const fulfilled = new Promise((resolve) => this.plugin.on('outgoing_fulfill', resolve))

      yield this.plugin.sendTransfer(this.transferJson)
      yield sent

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.btpFulfillment)
      yield fulfilled

      assert.equal((yield this.plugin.getBalance()), '-5', 'balance should decrease by amount')
    })

    it('fulfills an incoming transfer', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_RESPONSE)
        .reply(btpPacket.TYPE_FULFILL, ({requestId, data}) => {
          assert.equal(data.transferId, this.transferJson.id)
          assert.equal(data.fulfillment, this.fulfillment)
          return btpPacket.serializeResponse(requestId, [])
        })

      const fulfilled = new Promise((resolve) => this.plugin.on('incoming_fulfill', resolve))

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.incomingTransfer)
      yield this.plugin.fulfillCondition(this.transferJson.id, this.fulfillment)
      yield fulfilled

      assert.equal((yield this.plugin.getBalance()), '5', 'balance should increase by amount')
    })

    it('cancels an incoming transfer for too much money', function * () {
      this.incomingTransferJson.amount = 100
      this.incomingTransferJson.transferId = this.incomingTransferJson.id
      const transfer = btpPacket.serializePrepare(
        this.incomingTransferJson,
        12345,
        ilpAndCustomToProtocolData(this.incomingTransferJson)
      )

      let incomingPrepared = false
      this.plugin.on('incoming_prepare', () => (incomingPrepared = true))

      this.mockSocket.reply(btpPacket.TYPE_ERROR, ({requestId, data}) => {
        // TODO: assert data contains the expected rejection reason
      })

      yield expect(this.plugin._rpc.handleMessage(this.mockSocketIndex, transfer))
        .to.eventually.be.rejectedWith(/balanceIncomingFulfilledAndPrepared exceeds greatest allowed value/)

      assert.isFalse(incomingPrepared, 'incoming_prepare should not be emitted')
      assert.equal((yield this.plugin.getBalance()), '0', 'balance should not change')
    })

    it('should fulfill a transfer even if inital RPC failed', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      const fulfilled = new Promise((resolve) => this.plugin.on('outgoing_fulfill', resolve))
      const sent = new Promise((resolve) => this.plugin.on('outgoing_prepare', resolve))

      yield this.plugin.sendTransfer(this.transferJson)
      yield sent
      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.btpFulfillment)
      yield fulfilled

      assert.equal((yield this.plugin.getBalance()), '-5', 'balance should decrease by amount')
    })

    it('doesn\'t fulfill a transfer with invalid fulfillment', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      yield this.plugin.sendTransfer(this.transferJson)
      yield expect(this.plugin.fulfillCondition(this.transferJson.id, 'Garbage'))
        .to.eventually.be.rejected
    })

    it('doesn\'t fulfill an outgoing transfer', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      yield this.plugin.sendTransfer(this.transferJson)
      yield expect(this.plugin.fulfillCondition(this.transferJson.id, this.fulfillment))
        .to.eventually.be.rejected
    })

    it('should not send a transfer with condition and no expiry', function () {
      this.transferJson.executionCondition = undefined
      return expect(this.plugin.sendTransfer(this.transferJson)).to.eventually.be.rejected
    })

    it('should not send a transfer with expiry and no condition', function () {
      this.transferJson.expiresAt = undefined
      return expect(this.plugin.sendTransfer(this.transferJson)).to.eventually.be.rejected
    })

    it('should resolve even if the event notification handler takes forever', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      this.plugin.on('outgoing_prepare', () => new Promise((resolve, reject) => {}))

      yield this.plugin.sendTransfer(this.transferJson)
    })

    it('should resolve even if the event notification handler throws an error', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      this.plugin.on('outgoing_prepare', () => {
        throw new Error('blah')
      })

      yield this.plugin.sendTransfer(this.transferJson)
    })

    it('should resolve even if the event notification handler rejects', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      this.plugin.on('outgoing_prepare', function * () {
        throw new Error('blah')
      })

      yield this.plugin.sendTransfer(this.transferJson)
    })
  })

  describe('expireTransfer', () => {
    it('expires a transfer', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_RESPONSE)
        .reply(btpPacket.TYPE_REJECT, ({requestId, data}) => {
          assert.equal(data.transferId, this.incomingTransferJson.transferId)
          const [ ilp ] = data.protocolData.filter(p => p.protocolName === 'ilp')

          // TODO: check that the correct BTP error is returned once they are defined
          const reasonBuffer = ilp.data
          const reason = ilpPacket.deserializeIlpPacket(reasonBuffer).data
          delete reason.triggeredAt
          assert.deepEqual(reason, {
            code: 'R00',
            name: 'Transfer Timed Out',
            triggeredBy: 'example.red.server',
            forwardedBy: [],
            // triggeredAt: ...,
            data: 'expired'
          })
          return btpPacket.serializeResponse(requestId, [])
        })

      this.incomingTransferJson.expiresAt = (new Date(Date.now() + 10)).toISOString()
      this.incomingTransferJson.transferId = this.incomingTransferJson.id
      const incomingTransfer = btpPacket.serializePrepare(
        this.incomingTransferJson,
        12345,
        ilpAndCustomToProtocolData(this.incomingTransferJson)
      )

      const cancel = new Promise((resolve) => this.plugin.on('incoming_cancel', resolve))

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, incomingTransfer)
      yield cancel

      assert.equal((yield this.plugin.getBalance()), '0', 'balance should not change')
    })

    it('expires an outgoing transfer', function * () {
      this.transferJson.expiresAt = (new Date()).toISOString()
      const expectedTransfer = btpPacket.serializePrepare(
        Object.assign({}, this.transferJson, {transferId: this.transferJson.id}),
        12345,
        ilpAndCustomToProtocolData(this.transferJson)
      )

      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(expectedTransfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })
        .reply(btpPacket.TYPE_REJECT, ({requestId, data}) => {
          assert.equal(data.transferId, this.transferJson.id)
          const [ ilp ] = data.protocolData.filter(p => p.protocolName === 'ilp')

          // TODO: check that the correct BTP error is returned once they are defined
          const reasonBuffer = ilp.data
          const reason = ilpPacket.deserializeIlpPacket(reasonBuffer).data
          delete reason.triggeredAt
          assert.deepEqual(reason, {
            code: 'R00',
            name: 'Transfer Timed Out',
            triggeredBy: this.plugin.getAccount(),
            forwardedBy: [],
            // triggeredAt: ...,
            data: 'expired'
          })
          return btpPacket.serializeResponse(requestId, [])
        })

      const cancel = new Promise((resolve) => this.plugin.on('outgoing_cancel', resolve))

      yield this.plugin.sendTransfer(this.transferJson)
      yield cancel

      assert.equal((yield this.plugin.getBalance()), '0', 'balance should not change')
    })

    it('doesn\'t expire an executed transfer', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = btpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return btpPacket.serializeResponse(requestId, [])
        })

      const sent = new Promise((resolve) => this.plugin.on('outgoing_prepare', resolve))
      const fulfilled = new Promise((resolve) => this.plugin.on('outgoing_fulfill', resolve))

      yield this.plugin.sendTransfer(this.transferJson)
      yield sent

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.btpFulfillment)
      yield fulfilled
      yield this.plugin._expireTransfer(this.transferJson.id)

      assert.equal((yield this.plugin.getBalance()), '-5', 'balance should not be rolled back')
    })
  })

  describe('rejectIncomingTransfer', () => {
    it('rejects an incoming transfer', function * () {
      const expectedRejectionReason = {
        code: 'F00',
        name: 'Bad Request',
        triggeredBy: 'example.red.server',
        forwardedBy: [],
        triggeredAt: new Date(),
        data: 'reason'
      }

      this.mockSocket
        .reply(btpPacket.TYPE_RESPONSE)
        .reply(btpPacket.TYPE_REJECT, ({requestId, data}) => {
          const [ ilp ] = data.protocolData.filter(p => p.protocolName === 'ilp')
          const ilpError = ilpPacket.deserializeIlpPacket(ilp.data)
          assert.equal(data.transferId, this.transferJson.id)
          assert.deepEqual(ilpError.data, expectedRejectionReason)
          return btpPacket.serializeResponse(requestId, [])
        })

      const rejected = new Promise((resolve) => this.plugin.on('incoming_reject', resolve))

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.incomingTransfer)
      yield this.plugin.rejectIncomingTransfer(this.transferJson.id, expectedRejectionReason)
      yield rejected

      assert.equal((yield this.plugin.getBalance()), '0', 'balance should not change')
    })

    it('should allow an outgoing transfer to be rejected', function * () {
      this.mockSocket.reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = btpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)
        return btpPacket.serializeResponse(requestId, [])
      })

      const btpRejection = btpPacket.serializeReject({
        transferId: this.transferJson.id
      }, 1111, [{
        protocolName: 'ilp',
        contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: ilpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: 'g.your.friendly.peer',
          forwardedBy: [],
          triggeredAt: new Date(),
          data: 'reason'
        })
      }])

      const rejected = new Promise((resolve) => this.plugin.on('outgoing_reject', resolve))

      yield this.plugin.sendTransfer(this.transferJson)

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, btpRejection)
      yield rejected
    })

    it('should not reject an outgoing transfer', function * () {
      this.mockSocket.reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = btpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)
        return btpPacket.serializeResponse(requestId, [])
      })

      yield this.plugin.sendTransfer(this.transferJson)
      yield expect(this.plugin.rejectIncomingTransfer(this.transferJson.id, 'reason'))
        .to.eventually.be.rejected
    })

    it('should not allow an incoming transfer to be rejected by sender', function * () {
      this.mockSocket
        .reply(btpPacket.TYPE_RESPONSE)
        .reply(btpPacket.TYPE_ERROR, (requestId, data) => {
          // TODO: Once BTP Erros are defined, check the contents of the returned error (cc: sharafian)
          // ...
        })

      yield this.plugin._rpc.handleMessage(this.mockSocketIndex, this.incomingTransfer)

      const btpRejection = btpPacket.serializeReject({
        transferId: this.transferJson.id,
        rejectionReason: ilpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: 'g.your.friendly.peer',
          forwardedBy: [],
          triggeredAt: new Date(),
          data: 'reason'
        })
      }, 1111, [])
      yield expect(this.plugin._rpc.handleMessage(this.mockSocketIndex, btpRejection))
        .to.eventually.be.rejected
    })
  })
})
