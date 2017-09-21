'use strict'

const btpPacket = require('btp-packet')
const assert = require('chai').assert

const ObjStore = require('./helpers/objStore')
const PluginPaymentChannel = require('..')
const MockSocket = require('./helpers/mockSocket')
const { protocolDataToIlpAndCustom } =
  require('../src/util/protocolDataConverter')

const info = {
  prefix: 'example.red.',
  currencyScale: 2,
  currencyCode: 'USD',
  maxBalance: '1000000',
  connectors: [ { id: 'other', name: 'other', connector: 'peer.usd.other' } ]
}

const options = {
  prefix: 'example.red.',
  maxBalance: '1000000',
  btpUri: 'btp+wss://user:placeholder@example.com/rpc',
  info: info
}

describe('Info', () => {
  beforeEach(async function () {
    options._store = new ObjStore()
    this.plugin = new PluginPaymentChannel(options)

    this.mockSocketIndex = 0
    this.mockSocket = new MockSocket()
    this.mockSocket
      .reply(btpPacket.TYPE_MESSAGE, ({ requestId }) => btpPacket.serializeResponse(requestId, []))

    await this.plugin.addSocket(this.mockSocket, 'user', 'placeholder')
    await this.plugin.connect()
  })

  afterEach(async function () {
    assert(await this.mockSocket.isDone(), 'request handlers must have been called')
  })

  describe('getBalance', () => {
    it('should start at zero', function * () {
      assert.equal((yield this.plugin.getBalance()), '0')
    })
  })

  describe('getLimit', () => {
    it('return the result of the RPC call', function * () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        const expectedGetLimitRequest = {
          protocolData: [{
            protocolName: 'get_limit',
            contentType: btpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from('[]')
          }]
        }
        assert.deepEqual(data, expectedGetLimitRequest)

        return btpPacket.serializeResponse(requestId, [{
          protocolName: 'get_limit',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify('5'))
        }])
      })

      // the value is reversed so it makes sense to our side
      assert.equal((yield this.plugin.getLimit()), '-5')
    })

    it('handles getLimit requests', function * () {
      this.mockSocket.reply(btpPacket.TYPE_RESPONSE, ({requestId, data}) => {
        const {protocolMap} = protocolDataToIlpAndCustom(data)
        assert(protocolMap.get_limit)
        assert(protocolMap.get_limit, options.maxBalance)
      })

      const getLimitReq = btpPacket.serializeMessage(12345, [{
        protocolName: 'get_limit',
        contentType: btpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from('[]')
      }])
      this.mockSocket.emit('message', getLimitReq)
    })
  })

  describe('getPeerBalance', () => {
    it('return the result of the RPC call', function * () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        const expectedGetBalanceRequest = {
          protocolData: [{
            protocolName: 'get_balance',
            contentType: btpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from('[]')
          }]
        }
        assert.deepEqual(data, expectedGetBalanceRequest)

        return btpPacket.serializeResponse(requestId, [{
          protocolName: 'get_balance',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify('5'))
        }])
      })

      // the value is reversed so it makes sense to our side
      assert.equal((yield this.plugin.getPeerBalance()), '-5')
    })
  })

  describe('getInfo', () => {
    it('should use the supplied info', function () {
      assert.deepEqual(
        this.plugin.getInfo(),
        Object.assign({}, info, {prefix: this.plugin.getInfo().prefix}))
    })
  })

  describe('isAuthorized', () => {
    it('should authorize its own auth token', function () {
      assert.isTrue(this.plugin.isAuthorized(this.plugin._getAuthToken()))
    })

    it('should not authorize any other token', function () {
      assert.isFalse(this.plugin.isAuthorized('any other token'))
    })
  })

  describe('disconnect', () => {
    it('should disconnect when connected', function * () {
      assert.isTrue(this.plugin.isConnected(), 'should have connected before')
      yield this.plugin.disconnect()
      assert.isFalse(this.plugin.isConnected(), 'shouldn\'t be connected after disconnect')
    })

    it('should stay disconnected when disconnected', function * () {
      yield this.plugin.disconnect()
      yield this.plugin.disconnect()
      assert.isFalse(this.plugin.isConnected(), 'still should be disconnected after second disconnect')
    })

    it('should reconnect', function * () {
      yield this.plugin.disconnect()
      yield this.plugin.connect()
      assert.isTrue(this.plugin.isConnected(), 'should have reconnected')
    })
  })
})
