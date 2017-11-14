'use strict'

const crypto = require('crypto')
const uuid = require('uuid4')
const ilpPacket = require('ilp-packet')
const btpPacket = require('btp-packet')
const base64url = require('base64url')

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert

const ObjStore = require('./helpers/objStore')
const PluginPaymentChannel = require('..')
const MockSocket = require('./helpers/mockSocket')

const info = {
  currencyCode: 'USD',
  currencyScale: 2
}

const options = {
  currencyCode: 'USD',
  currencyScale: 2,
  maxBalance: '1000000',
  minBalance: '-40',
  server: 'btp+wss://user:placeholder@example.com/rpc',
  info: info
}

describe.only('LPI2', () => {
  beforeEach(async function () {
    options._store = new ObjStore()
    this.plugin = new PluginPaymentChannel(options)

    this.mockSocketIndex = 0
    this.mockSocket = new MockSocket()
    this.mockSocket
      .reply(btpPacket.TYPE_MESSAGE, ({ requestId }) => btpPacket.serializeResponse(requestId, []))

    await this.plugin.addSocket(this.mockSocket, { username: 'user', token: 'placeholder' })
    await this.plugin.connect()

    this.error = {
      code: 'F00',
      name: 'Bad Request',
      triggeredAt: new Date(),
      data: JSON.stringify({ message: 'Peer isn\'t feeling like it.' })
    }

    const expiry = new Date(Date.now() + 10000)
    this.fulfillment = 'gHJ2QeIZpstXaGZVCSq4d3vkrMSChNYKriefys3KMtI'
    this.condition = base64url(crypto
      .createHash('sha256')
      .update(this.fulfillment, 'base64')
      .digest())

    this.transfer = {
      id: uuid(),
      amount: '5',
      executionCondition: this.condition,
      expiresAt: expiry.toISOString()
    }
  })

  afterEach(async function () {
    assert(await this.mockSocket.isDone(), 'request handlers must have been called')
  })

  describe('sendTransfer', () => {
    it('should perform a transfer that fulfills', async function () {
      const btpFulfillment = btpPacket.serializeFulfill({
        transferId: this.transfer.id,
        fulfillment: this.fulfillment
      }, 1, [ {
        protocolName: 'ilp',
        contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from('09050365965900', 'hex')
      } ])

      this.mockSocket.reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
        setImmediate(() => {
          this.plugin._rpc.handleMessage(this.mockSocketIndex, btpFulfillment)
        })
        return btpPacket.serializeResponse(requestId, [])
      })
      this.mockSocket.reply(btpPacket.TYPE_RESPONSE)

      await this.plugin.sendTransfer(this.transfer)
    })

    it('should perform a transfer that rejects', async function () {
      const ilpError = {
        code: 'F00',
        name: 'Bad Request',
        triggeredBy: 'g.your.friendly.peer',
        forwardedBy: [],
        triggeredAt: new Date(),
        data: JSON.stringify({ extra: 'data' })
      }

      const btpRejection = btpPacket.serializeReject({
        transferId: this.transfer.id
      }, 1, [{
        protocolName: 'ilp',
        contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: ilpPacket.serializeIlpError(ilpError)
      }])

      this.mockSocket.reply(btpPacket.TYPE_PREPARE, ({requestId, data}) => {
        setImmediate(() => {
          this.plugin._rpc.handleMessage(this.mockSocketIndex, btpRejection)
        })
        return btpPacket.serializeResponse(requestId, [])
      })
      this.mockSocket.reply(btpPacket.TYPE_RESPONSE)

      await assert.isRejected(this.plugin.sendTransfer(this.transfer))
    })
  })
})
