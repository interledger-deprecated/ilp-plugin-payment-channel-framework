'use strict'

const clpPacket = require('clp-packet')
const assert = require('chai').assert
// const nock = require('nock')

const ObjStore = require('./helpers/objStore')
const PluginPaymentChannel = require('..')
const MockSocket = require('./helpers/mockSocket')

const info = {
  prefix: 'example.red.',
  currencyScale: 2,
  currencyCode: 'USD',
  maxBalance: '1000000',
  connectors: [ { id: 'other', name: 'other', connector: 'peer.usd.other' } ]
}

const options = {
  prefix: 'example.red.',
  token: 'placeholder',
  maxBalance: '1000000',
  rpcUri: 'https://example.com/rpc',
  info: info
}

describe('Info', () => {
  beforeEach(function * () {
    options._store = new ObjStore()
    this.plugin = new PluginPaymentChannel(options)

    this.mockSocket = new MockSocket()
    this.plugin.addSocket(this.mockSocket)
    yield this.plugin.connect()
  })

  afterEach(function * () {
    assert(this.mockSocket.isDone(), 'request handlers must have been called')
  })

  describe('getBalance', () => {
    it('should start at zero', function * () {
      assert.equal((yield this.plugin.getBalance()), '0')
    })
  })

  describe('getLimit', () => {
    it('return the result of the RPC call', function * () {
      this.mockSocket.reply(clpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        const expectedGetLimitRequest = {
          protocolData: [{
            protocolName: 'get_limit',
            contentType: clpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from('[]')
          }]
        }
        assert.deepEqual(data, expectedGetLimitRequest)

        return clpPacket.serializeResponse(requestId, [{
          protocolName: 'get_limit',
          contentType: clpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from('5')
        }])
      })

      // the value is reversed so it makes sense to our side
      assert.equal((yield this.plugin.getLimit()), '-5')
    })
  })

  describe('getPeerBalance', () => {
    it('return the result of the RPC call', function * () {
      this.mockSocket.reply(clpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        const expectedGetBalanceRequest = {
          protocolData: [{
            protocolName: 'get_balance',
            contentType: clpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from('[]')
          }]
        }
        assert.deepEqual(data, expectedGetBalanceRequest)

        return clpPacket.serializeResponse(requestId, [{
          protocolName: 'get_balance',
          contentType: clpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from('5')
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
