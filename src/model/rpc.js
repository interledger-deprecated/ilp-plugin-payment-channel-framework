const EventEmitter = require('events')
const clpPacket = require('clp-packet')
const ilpPacket = require('ilp-packet')
const WebSocket = require('ws')
const assert = require('assert')
const crypto = require('crypto')

// TODO: make it configurable
const DEFAULT_TIMEOUT = 5000

module.exports = class ClpRpc extends EventEmitter {
  constructor ({ rpcUri, plugin, handlers, debug }) {
    assert(typeof handlers[clpPacket.TYPE_PREPARE] === 'function', 'Prepare handler missing')
    assert(typeof handlers[clpPacket.TYPE_FULFILL] === 'function', 'Fulfill handler missing')
    assert(typeof handlers[clpPacket.TYPE_REJECT] === 'function', 'Reject handler missing')
    assert(typeof handlers[clpPacket.TYPE_MESSAGE] === 'function', 'Message handler missing')
    assert(typeof rpcUri === 'string', 'rpcUri must be string')
    assert(typeof plugin === 'object', 'plugin must be provided')

    super()
    this._sockets = []
    this._handlers = handlers
    this._rpcUri = rpcUri
    this._plugin = plugin
    this.debug = debug
  }

  addSocket (socket) {
    _assertSocket(socket)
    this.debug('adding socket')
    this._sockets.push(socket)
    socket.on('message', async (message) => {
      try {
        await this.handleMessage(socket, message)
      } catch (err) {
        this.debug(`RPC Error: ${err.message}. Message was ${JSON.stringify(message)}`)
      }
    })
  }

  async handleMessage (socket, message) {
    _assertSocket(socket)
    const {type, requestId, data} = clpPacket.deserialize(message)
    const typeString = clpPacket.typeToString(type)
    if (data.transferId) {
      data.id = data.transferId
      delete data.transferId
    }

    this.debug(`received CLP packet (${typeString}, RequestId: ${requestId}): ${JSON.stringify(data)}`)
    switch (type) {
      case clpPacket.TYPE_ACK:
      case clpPacket.TYPE_RESPONSE:
      case clpPacket.TYPE_ERROR:
        this.emit('_' + requestId, type, data)
        return

      case clpPacket.TYPE_PREPARE:
      case clpPacket.TYPE_FULFILL:
      case clpPacket.TYPE_REJECT:
      case clpPacket.TYPE_MESSAGE:
        break

      default:
        throw new Error(type + ' is not a valid clp packet type')
    }

    try {
      const result = await this._handlers[type].call(null, {requestId, data})
      this.debug(`replying to request ${requestId} with ${JSON.stringify(result)}`)
      await _send(socket, clpPacket.serializeResponse(requestId, result || []))
    } catch (e) {
      this.debug(`Error calling message handler ${typeString}: `, e)
      const ilp = ilpPacket.serializeIlpError({
        code: 'F00',
        name: 'Bad Request',
        triggeredBy: this._plugin.getAccount(),
        forwardedBy: [],
        triggeredAt: new Date(),
        data: JSON.stringify({ message: e.message })
      })
      await _send(socket, clpPacket.serializeError({rejectionReason: ilp}, requestId, []))
      throw e
    }
  }

  async _call (id, data) {
    if (!this._sockets.length) {
      await this._connect()
    }

    await Promise.all(this._sockets.map(async (socket) => _send(socket, data)))

    let callback
    const response = new Promise((resolve, reject) => {
      callback = (type, data) => {
        switch (type) {
          case clpPacket.TYPE_ACK:
          case clpPacket.TYPE_RESPONSE:
            resolve(data)
            break

          case clpPacket.TYPE_ERROR:
            reject(new Error(JSON.stringify(data)))
            break

          default:
            throw new Error('Unkown CLP packet type', data)
        }
      }
      this.once('_' + id, callback)
    })

    const timeout = new Promise((resolve, reject) =>
      setTimeout(() => {
        this.removeListener('_' + id, callback)
        reject(new Error(id + ' timed out'))
      }, DEFAULT_TIMEOUT))

    return Promise.race([
      response,
      timeout
    ])
  }

  async prepare ({id, amount, executionCondition, expiresAt}, protocolData) {
    const requestId = await _requestId()
    const prepareRequest = clpPacket.serializePrepare({
      transferId: id,
      amount,
      executionCondition,
      expiresAt
    }, requestId, protocolData)

    return this._call(requestId, prepareRequest)
  }

  async fulfill ({id, fulfillment}, protocolData) {
    const requestId = await _requestId()
    const fulfillRequest = clpPacket.serializeFulfill({
      transferId: id,
      fulfillment
    }, requestId, protocolData)

    return this._call(requestId, fulfillRequest)
  }

  async reject ({id, rejectionReason}, protocolData) {
    const requestId = await _requestId()
    const rejectRequest = clpPacket.serializeReject({
      transferId: id,
      rejectionReason
    }, requestId, protocolData)

    return this._call(requestId, rejectRequest)
  }

  async message ({ protocolData }) {
    const requestId = await _requestId()
    const messageRequest = clpPacket.serializeMessage(requestId, protocolData)

    return this._call(requestId, messageRequest)
  }

  async _connect () {
    const ws = new WebSocket(this._rpcUri)
    return new Promise((resolve) => {
      ws.on('open', () => resolve())
    })
  }

  disconnect () {
    this._sockets.map((socket) => {
      socket.close()
    })
    this._sockets = []
  }
}

function _send (socket, data) {
  return new Promise((resolve, reject) => {
    socket.send(data, {binary: true}, (err) => {
      if (err) {
        reject(err)
      }
      resolve()
    })
  })
}

async function _requestId () {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(4, (err, buf) => {
      if (err) reject(err)
      resolve(buf.readUInt32BE(0))
    })
  })
}

function _assertSocket (socket) {
  if (typeof socket.send !== 'function' ||
      typeof socket.on !== 'function') {
    throw new TypeError(`Argument expected to be a socket object.`)
  }
}
