'use strict'

const crypto = require('crypto')
const uuid = require('uuid4')
const base64url = require('base64url')
const clpPacket = require('clp-packet')

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert

const ObjStore = require('./helpers/objStore')
const MockSocket = require('./helpers/mockSocket')
const makePaymentChannelPlugin = require('..').makePaymentChannelPlugin
const { ilpAndCustomToProtocolData } =
  require('../src/util/protocolDataConverter')

describe('makePaymentChannelPlugin', function () {
  beforeEach(async function () {
    this.prefix = 'example.red.'
    this.account = 'example.red.alice'
    this.peerAccount = 'example.red.bob'

    this.info = {
      prefix: 'example.red.',
      currencyCode: 'USD',
      currencyScale: 2,
      connectors: [ { id: 'other', name: 'other', connector: 'peer.usd.other' } ]
    }

    this.opts = {
      currencyCode: 'USD',
      currencyScale: 2,
      secret: 'seeecret',
      maxBalance: '1000000',
      minBalance: '-40',
      rpcUri: 'https://example.com/rpc',
      info: this.info,
      _store: new ObjStore()
    }

    this.channel = {
      pluginName: 'dummy',
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      handleIncomingPrepare: () => Promise.resolve(),
      createOutgoingClaim: () => Promise.resolve(),
      handleIncomingClaim: () => Promise.resolve(),
      getInfo: () => this.info,
      getAccount: () => this.account,
      getPeerAccount: () => this.peerAccount,
      getAuthToken: () => 'placeholder'
    }

    this.PluginClass = makePaymentChannelPlugin(this.channel)
    this.plugin = new (this.PluginClass)(this.opts)

    this.fulfillment = crypto.randomBytes(32)

    this.transferJson = {
      id: uuid(),
      ledger: this.plugin.getInfo().prefix,
      from: this.plugin.getAccount(),
      to: this.plugin.getPeerAccount(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      amount: '5',
      custom: {
        field: 'some stuff'
      },
      executionCondition: base64url(crypto
        .createHash('sha256')
        .update(this.fulfillment)
        .digest())
    }
    const requestId = 12345

    this.transfer = clpPacket.serializePrepare(
      Object.assign({}, this.transferJson, {transferId: this.transferJson.id}),
      requestId,
      ilpAndCustomToProtocolData(this.transferJson))
    this.clpFulfillment = clpPacket.serializeFulfill({
      transferId: this.transferJson.id,
      fulfillment: base64url(this.fulfillment)
    }, requestId + 1, [])

    this.mockSocket = new MockSocket()
    this.plugin.addSocket(this.mockSocket)

    await this.plugin.connect()
  })

  afterEach(async function () {
    assert(await this.mockSocket.isDone(), 'request handlers must have been called')
  })

  describe('constructor', function () {
    it('should be called at construct time', function () {
      let called = false
      this.channel.constructor = (ctx, opts) => {
        called = true
        assert.deepEqual(ctx.state, {})
        assert.equal(opts, this.opts)
      }

      const res = new (this.PluginClass)(this.opts)
      assert.isObject(res)
      assert.equal(called, true)
    })

    it('should give the right name to the class', function () {
      assert.equal(this.PluginClass.name, 'PluginDummy')
    })
  })

  describe('connect', function () {
    it('is called when the plugin connects', async function () {
      let called = false
      this.channel.connect = (ctx, opts) => {
        called = true
      }

      await this.plugin.connect()
      assert.equal(called, true)
    })

    it('causes connect to fail if it throws', async function () {
      let called = false
      this.channel.connect = (ctx, opts) => {
        called = true
        throw new Error('no')
      }

      await assert.isRejected(this.plugin.connect(), /^no$/)
      assert.equal(called, true)
    })
  })

  describe('disconnect', function () {
    it('is called when the plugin disconnects', async function () {
      await this.plugin.connect()

      let called = false
      this.channel.disconnect = (ctx, opts) => {
        called = true
        assert.deepEqual(ctx.state, {})
        assert.equal(ctx.plugin, this.plugin)
      }

      await this.plugin.disconnect()
      assert.equal(called, true)
    })
  })

  describe('handleIncomingPrepare', function () {
    it('should be called when a transfer is prepared', async function () {
      let called = false
      this.channel.handleIncomingPrepare = (ctx, transfer) => {
        called = true
        assert.deepEqual(ctx.state, {})
        assert.equal(ctx.plugin, this.plugin)
        assert.deepEqual(transfer, this.transferJson)
      }

      this.transferJson.from = this.transferJson.to
      this.transferJson.to = this.plugin.getAccount()
      const emitted = new Promise((resolve) => this.plugin.on('incoming_prepare', resolve))

      this.plugin._rpc.handleMessage(this.mockSocket, this.transfer)
      await emitted
      assert.equal(called, true)

      assert.equal(await this.plugin._transfers.getIncomingFulfilledAndPrepared(), '5')
    })

    it('should make prepare throw if handler throws', async function () {
      let called = false
      this.channel.handleIncomingPrepare = (ctx, transfer) => {
        called = true
        throw new Error('no')
      }

      this.transfer.from = this.transfer.to
      this.transfer.to = this.plugin.getAccount()

      let emitted = false
      this.plugin.on('incoming_prepare', () => {
        emitted = true
      })

      this.mockSocket.reply(clpPacket.TYPE_ERROR)

      await assert.isRejected(
        this.plugin._rpc.handleMessage(this.mockSocket, this.transfer),
        /^no$/)

      assert.equal(called, true)
      assert.equal(emitted, false, 'should not emit if handleIncoming throws')

      // should cancel the payment
      assert.equal(await this.plugin._transfers.getIncomingFulfilledAndPrepared(), '0')
    })
  })

  describe('createOutgoingClaim', function () {
    it('should be called when an outgoing transfer is fulfilled', async function () {
      const called = new Promise((resolve, reject) => {
        this.channel.createOutgoingClaim = (ctx, outgoing) => {
          try {
            assert.deepEqual(ctx.state, {})
            assert.equal(ctx.plugin, this.plugin)
            assert.equal(outgoing, '5')
          } catch (e) {
            reject(e)
          }
          resolve()
          return { foo: 'bar' }
        }
      })

      this.mockSocket.reply(clpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = clpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)
        return clpPacket.serializeResponse(requestId, [])
      }).reply(clpPacket.TYPE_RESPONSE)

      await this.plugin.sendTransfer(this.transferJson)

      await this.plugin._rpc.handleMessage(this.mockSocket, this.clpFulfillment)

      await called
      assert.equal(await this.plugin._transfers.getOutgoingFulfilled(), '5')
    })

    it('should not fail fulfillCondition if it fails', async function () {
      this.channel.createOutgoingClaim = (ctx, outgoing) => {
        throw new Error('this will be logged but swallowed')
      }

      this.mockSocket.reply(clpPacket.TYPE_PREPARE, ({requestId, data}) => {
        const expectedPacket = clpPacket.deserialize(this.transfer)
        assert.deepEqual(data, expectedPacket.data)

        return clpPacket.serializeResponse(requestId, [])
      }).reply(clpPacket.TYPE_RESPONSE)

      await this.plugin.sendTransfer(this.transferJson)
      await this.plugin._rpc.handleMessage(this.mockSocket, this.clpFulfillment)

      assert.equal(await this.plugin._transfers.getOutgoingFulfilled(), '5')
    })
  })

  describe('handleIncomingClaim', function () {
    it('should be called when an incoming transfer is fulfilled', async function () {
      const called = new Promise((resolve, reject) => {
        this.channel.handleIncomingClaim = (ctx, claim) => {
          try {
            assert.deepEqual(ctx.state, {})
            assert.equal(ctx.plugin, this.plugin)
            // TODO: Decide on the claim side-protocol
            assert.deepEqual(claim, { foo: 'bar' })
          } catch (e) {
            reject(e)
          }
          resolve()
        }
      })

      this.mockSocket
        .reply(clpPacket.TYPE_RESPONSE)
        .reply(clpPacket.TYPE_FULFILL, ({requestId, data}) => {
          return clpPacket.serializeResponse(requestId, [{
            protocolName: 'claim',
            contentType: clpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({ foo: 'bar' }))
          }])
        })

      this.transfer.from = this.transfer.to
      this.transfer.to = this.plugin.getAccount()

      await this.plugin._rpc.handleMessage(this.mockSocket, this.transfer)
      await this.plugin.fulfillCondition(this.transferJson.id, base64url(this.fulfillment))

      await called
    })

    it('should not fail fulfillCondition if it throws', async function () {
      this.channel.handleIncomingClaim = (ctx, claim) => {
        throw new Error('will be logged but swallowed')
      }

      this.mockSocket
        .reply(clpPacket.TYPE_RESPONSE)
        .reply(clpPacket.TYPE_FULFILL, ({requestId, data}) => {
          assert.equal(data.transferId, this.transferJson.id)
          assert.equal(data.fulfillment, base64url(this.fulfillment))
          return clpPacket.serializeResponse(requestId, [{
            protocolName: 'claim',
            contentType: clpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({ foo: 'bar' }))
          }])
        })

      this.transfer.from = this.transfer.to
      this.transfer.to = this.plugin.getAccount()

      await this.plugin._rpc.handleMessage(this.mockSocket, this.transfer)
      await this.plugin.fulfillCondition(this.transferJson.id, base64url(this.fulfillment))
    })
  })
})
