'use strict'

const crypto = require('crypto')
const base64url = require('base64url')
const clpPacket = require('clp-packet')
const ilpPacket = require('ilp-packet')

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert

const getObjBackend = require('../src/util/backend')
const MockSocket = require('./helpers/mockSocket')
const PluginPaymentChannel = require('..')
const { ilpAndCustomToProtocolData } =
  require('../src/util/protocolDataConverter')

const conditionPair = () => {
  const preimage = crypto.randomBytes(32)
  const hash = crypto.createHash('sha256').update(preimage).digest()

  return {
    fulfillment: base64url(preimage),
    condition: base64url(hash)
  }
}

const info = {
  prefix: 'example.red.',
  currencyCode: 'USD',
  currencyScale: 2,
  connectors: [ { id: 'other', name: 'other', connector: 'peer.usd.other' } ]
}

const peerAddress = 'example.red.server'
const options = {
  prefix: 'example.red.',
  token: 'placeholder',
  currencyCode: 'USD',
  currencyScale: 2,
  maxBalance: '1000000',
  minBalance: '-40',
  rpcUri: 'https://example.com/rpc'
}

describe('Asymmetric plugin virtual', () => {
  beforeEach(function * () {
    this.mockSocket = new MockSocket()
    this.mockSocket.reply(clpPacket.TYPE_MESSAGE, ({requestId}) => {
      return clpPacket.serializeResponse(requestId, [{
        protocolName: 'get_info',
        contentType: clpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(info))
      }])
    })

    this.plugin = new PluginPaymentChannel(Object.assign({},
      options))

    this.plugin.addSocket(this.mockSocket)
    yield this.plugin.connect()
  })

  afterEach(async function () {
    assert(await this.mockSocket.isDone(), 'response handlers must be called')
  })

  describe('setup', () => {
    it('should get info from rpc endpoint', function () {
      assert.deepEqual(this.plugin.getInfo(), info)
    })

    it('should get balance from peer', async function () {
      this.mockSocket.reply(clpPacket.TYPE_MESSAGE, ({requestId}) => {
        return clpPacket.serializeResponse(requestId, [{
          protocolName: 'get_balance',
          contentType: clpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify('-5'))
        }])
      })

      assert.equal(await this.plugin.getBalance(), '5')
    })
  })

  describe('sending', () => {
    beforeEach(function () {
      const { condition, fulfillment } = conditionPair()

      this.condition = condition
      this.fulfillment = fulfillment
      this.transferJson = {
        id: '5709e97e-ffb5-5454-5c53-cfaa5a0cd4c1',
        to: peerAddress,
        amount: '10',
        executionCondition: condition,
        expiresAt: new Date(Date.now() + 1000).toISOString()
      }
      const requestId = 12345

      this.transfer = clpPacket.serializePrepare(
        Object.assign({},
          this.transferJson,
          {transferId: this.transferJson.id}),
        requestId,
        ilpAndCustomToProtocolData(this.transferJson)
      )
      this.clpFulfillment = clpPacket.serializeFulfill({
        transferId: this.transferJson.id,
        fulfillment: this.fulfillment
      }, requestId + 1, [])
    })

    it('should send a request', async function () {
      const response = {
        to: this.plugin.getAccount(),
        from: this.plugin.getPeerAccount(),
        ledger: this.plugin._prefix,
        ilp: base64url('some_base64_encoded_data_goes_here')
      }

      this.mockSocket.reply(clpPacket.TYPE_MESSAGE, ({requestId}) => {
        return clpPacket.serializeResponse(requestId,
          ilpAndCustomToProtocolData(response))
      })

      const result = await this.plugin.sendRequest({
        to: peerAddress,
        ilp: 'some_data'
      })

      assert.deepEqual(result, response)
    })

    it('should prepare and execute a transfer', async function () {
      this.mockSocket.reply(clpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = clpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)
        return clpPacket.serializeResponse(requestId, [])
      })

      const prepared = new Promise((resolve) =>
        this.plugin.once('outgoing_prepare', () => resolve()))

      await this.plugin.sendTransfer(this.transferJson)
      await prepared

      const fulfilled = new Promise((resolve) =>
        this.plugin.once('outgoing_fulfill', () => resolve()))

      await this.plugin._rpc.handleMessage(this.mockSocket, this.clpFulfillment)
      await fulfilled
    })

    it('should receive and fulfill a transfer', async function () {
      this.transferJson.to = this.plugin.getAccount()

      this.mockSocket
        .reply(clpPacket.TYPE_RESPONSE, ({requestId, data}) => {
          return clpPacket.serializeResponse(requestId, [])
        })
        .reply(clpPacket.TYPE_FULFILL, ({requestId, data}) => {
          assert.equal(data.transferId, this.transferJson.id)
          assert.equal(data.fulfillment, this.fulfillment)
          return clpPacket.serializeResponse(requestId, [])
        })

      const prepared = new Promise((resolve) =>
        this.plugin.once('incoming_prepare', () => resolve()))

      await this.plugin._rpc.handleMessage(this.mockSocket, this.transfer)
      await prepared

      const fulfilled = new Promise((resolve) =>
        this.plugin.once('incoming_fulfill', () => resolve()))

      await this.plugin.fulfillCondition(this.transferJson.id, this.fulfillment)
      await fulfilled
    })

    it('should not send a transfer if peer gives error', async function () {
      this.mockSocket
        .reply(clpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = clpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)

          const ilp = ilpPacket.serializeIlpError({
            code: 'F00',
            name: 'Bad Request',
            triggeredBy: '',
            forwardedBy: [],
            triggeredAt: new Date(),
            data: JSON.stringify({ message: 'Peer isn\'t feeling like it.' })
          })

          return clpPacket.serializeError({rejectionReason: ilp}, requestId, [])
        })

      const prepared = new Promise((resolve, reject) => {
        this.plugin.once('outgoing_prepare', () => {
          reject(new Error('should not be accepted'))
        })
        setTimeout(resolve, 10)
      })

      await assert.isRejected(this.plugin.sendTransfer(this.transferJson))
      await prepared
    })
  })

  describe('server', function () {
    // TODO: Is this test case still relevant?  (cc: sharafian)
    // Would you ever add several several sockets to a single plugin?
    it.skip('should call several plugins over RPC', async function () {
      const _options = Object.assign({}, options)

      delete _options.rpcUri
      _options.info = info
      _options._backend = getObjBackend(null)
      _options.tolerateFailure = true
      _options.rpcUris = [
        'https://example.com/1/rpc',
        'https://example.com/2/rpc',
        'https://example.com/3/rpc'
      ]

      this.mockSocket
        .reply(clpPacket.TYPE_PREPARE, ({requestId, data}) => {
          const expectedPacket = clpPacket.deserialize(this.transfer)
          assert.deepEqual(data, expectedPacket.data)
          return clpPacket.serializeResponse(requestId, [])
        })
        // .reply(....)

      // nock('https://example.com')
      //   .post('/1/rpc?method=send_transfer&prefix=example.red.')
      //   .reply(200, true)
      //   .post('/2/rpc?method=send_transfer&prefix=example.red.')
      //   .reply(200, true)
      //   .post('/3/rpc?method=send_transfer&prefix=example.red.')
      //   .reply(500) // should tolerate an error from one

      this.plugin = new PluginPaymentChannel(_options)
      await this.plugin.connect()

      await this.plugin.sendTransfer({
        id: '0aad44fd-a64e-537a-14b0-aec8a4e80b9c',
        to: this.plugin.getPeerAccount(),
        amount: '10',
        executionCondition: '8EhfVB4NBL3Bpa7PPqA0-LbJPg_xGyNnnRkBJ1oYLSU',
        expiresAt: new Date(Date.now() + 1000).toISOString()
      })
    })
  })
})
