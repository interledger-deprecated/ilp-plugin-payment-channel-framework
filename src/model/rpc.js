const EventEmitter = require('events')
const btpPacket = require('btp-packet')
const WebSocket = require('ws')
const assert = require('assert')
const crypto = require('crypto')

// TODO: make it configurable
const DEFAULT_TIMEOUT = 5000
const namesToCodes = {
  'UnreachableError': 'T00',
  'NotAcceptedError': 'F00',
  'InvalidFieldsError': 'F01',
  'TransferNotFoundError': 'F02',
  'InvalidFulfillmentError': 'F03',
  'DuplicateIdError': 'F04',
  'AlreadyRolledBackError': 'F05',
  'AlreadyFulfilledError': 'F06',
  'InsufficientBalanceError': 'F07'
}

function jsErrorToBtpError (e) {
  const name = e.name || 'NotAcceptedError'
  const code = namesToCodes[name] || 'F00'

  return {
    code,
    name,
    triggeredAt: new Date(),
    data: JSON.stringify({ message: e.message })
  }
}

module.exports = class BtpRpc extends EventEmitter {
  constructor ({ rpcUri, plugin, handlers, debug }) {
    assert(typeof handlers[btpPacket.TYPE_PREPARE] === 'function', 'Prepare handler missing')
    assert(typeof handlers[btpPacket.TYPE_FULFILL] === 'function', 'Fulfill handler missing')
    assert(typeof handlers[btpPacket.TYPE_REJECT] === 'function', 'Reject handler missing')
    assert(typeof handlers[btpPacket.TYPE_MESSAGE] === 'function', 'Message handler missing')
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
      this.debug('got message:', Buffer.from(message).toString('hex'))
      try {
        await this.handleMessage(socket, message)
      } catch (err) {
        this.debug(`RPC Error: ${err.message}. Message was ${JSON.stringify(message)}`)
      }
    })
  }

  setAuthToken (token) {
    this._token = token
  }

  async handleMessage (socket, message) {
    _assertSocket(socket)
    const {type, requestId, data} = btpPacket.deserialize(message)
    const typeString = btpPacket.typeToString(type)
    if (data.transferId) {
      data.id = data.transferId
      delete data.transferId
    }

    this.debug(`received BTP packet (${typeString}, RequestId: ${requestId}): ${JSON.stringify(data)}`)
    switch (type) {
      case btpPacket.TYPE_RESPONSE:
      case btpPacket.TYPE_ERROR:
        this.emit('_' + requestId, type, data)
        return

      case btpPacket.TYPE_PREPARE:
      case btpPacket.TYPE_FULFILL:
      case btpPacket.TYPE_REJECT:
      case btpPacket.TYPE_MESSAGE:
        break

      default:
        throw new Error(type + ' is not a valid btp packet type')
    }

    try {
      const result = await this._handlers[type].call(null, {requestId, data})
      this.debug(`replying to request ${requestId} with ${JSON.stringify(result)}`)
      await _send(socket, btpPacket.serializeResponse(requestId, result || []))
    } catch (e) {
      this.debug(`Error calling message handler ${typeString}: `, e)
      const error = jsErrorToBtpError(e)

      await _send(socket, btpPacket.serializeError(error, requestId, []))
      throw e
    }
  }

  async _call (id, data) {
    if (!this._sockets.length) {
      this.debug('connecting socket')
      await this._connect()
    }

    this.debug('sending ', Buffer.from(data).toString('hex'))
    await Promise.all(this._sockets.map(async (socket) => _send(socket, data)))

    let callback
    const response = new Promise((resolve, reject) => {
      callback = (type, data) => {
        switch (type) {
          case btpPacket.TYPE_RESPONSE:
            resolve(data)
            break

          case btpPacket.TYPE_ERROR:
            reject(new Error(JSON.stringify(data)))
            break

          default:
            throw new Error('Unkown BTP packet type', data)
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

  async prepare (transfer, protocolData) {
    const {id, amount, executionCondition, expiresAt} = transfer
    const requestId = await _requestId()
    const prepareRequest = btpPacket.serializePrepare({
      transferId: id,
      amount,
      executionCondition,
      expiresAt
    }, requestId, protocolData)

    return this._call(requestId, prepareRequest)
  }

  async fulfill (transferId, fulfillment, protocolData) {
    const requestId = await _requestId()
    const fulfillRequest = btpPacket.serializeFulfill({
      transferId,
      fulfillment
    }, requestId, protocolData)

    return this._call(requestId, fulfillRequest)
  }

  async reject (transferId, protocolData) {
    const requestId = await _requestId()
    const rejectRequest = btpPacket.serializeReject({
      transferId
    }, requestId, protocolData)

    return this._call(requestId, rejectRequest)
  }

  async message (protocolData) {
    const requestId = await _requestId()
    const messageRequest = btpPacket.serializeMessage(requestId, protocolData)

    this.debug('send message:', messageRequest)
    return this._call(requestId, messageRequest)
  }

  async _connect () {
    // This follows the:
    // wss://${HOSTNAME}:${PORT}/${NAME}/${TOKEN}
    // format outlined in https://github.com/interledger/interledger/wiki/Interledger-over-BTP
    // TODO: URL escape
    const uri = this._rpcUri +
      '/' + this._plugin.getInfo().prefix +
      '/' + this._token

    this.debug('connecting to', uri)
    const ws = new WebSocket(uri)

    return new Promise((resolve) => {
      ws.on('open', () => {
        this.addSocket(ws)
        resolve()
      })
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
