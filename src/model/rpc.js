const EventEmitter = require('events')
const btpPacket = require('btp-packet')
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
  constructor ({ client, plugin, handlers, incomingAuthToken, debug }) {
    assert(typeof handlers[btpPacket.TYPE_PREPARE] === 'function', 'Prepare handler missing')
    assert(typeof handlers[btpPacket.TYPE_FULFILL] === 'function', 'Fulfill handler missing')
    assert(typeof handlers[btpPacket.TYPE_REJECT] === 'function', 'Reject handler missing')
    assert(typeof handlers[btpPacket.TYPE_MESSAGE] === 'function', 'Message handler missing')
    assert(!client || typeof client === 'object', 'client must be an object')
    assert(typeof plugin === 'object', 'plugin must be provided')

    super()
    this._sockets = []
    this._handlers = handlers
    this._client = client
    this._plugin = plugin
    this._incomingAuthToken = incomingAuthToken
    this.debug = debug
  }

  async addSocket (socket, authUsername, authToken) {
    const newSocketIndex = this._sockets.length
    const isClient = Boolean(authToken)
    _assertSocket({ socket, authorized: isClient })

    this.debug('adding socket')

    // if we're the client on this socket, we don't need to receive
    // any authentication data. we have to send it instead.
    this._sockets.push({ socket, authorized: isClient })
    socket.on('message', async (message) => {
      this.debug('got message:', Buffer.from(message).toString('hex'))
      try {
        await this.handleMessage(newSocketIndex, message)
      } catch (err) {
        this.debug(`RPC Error: ${err.message}. Message was ${JSON.stringify(message)}`)
      }
    })

    // if this is a client, then send a special request with which to
    // authenticate.
    if (isClient) {
      const requestId = await _requestId()
      await _send(socket, btpPacket.serializeMessage(requestId, [{
        protocolName: 'auth',
        contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from([])
      }, {
        protocolName: 'auth_username',
        contentType: btpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(authUsername, 'utf8')
      }, {
        protocolName: 'auth_token',
        contentType: btpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(authToken, 'utf8')
      }]))

      return new Promise((resolve, reject) => {
        const handleAuthResponse = (type, data) => {
          if (type === btpPacket.TYPE_RESPONSE) {
            resolve(data)
          } else if (type === btpPacket.TYPE_ERROR) {
            reject(new Error(JSON.stringify(data)))
          } else {
            reject(new Error('Unkown BTP packet type', data))
          }
        }

        this.once('_' + requestId, handleAuthResponse)
      })
    }
  }

  setAuthToken (token) {
    this._token = token
  }

  async handleMessage (socketIndex, message) {
    const socketData = this._sockets[socketIndex]
    _assertSocket(socketData)

    const socket = socketData.socket
    const {type, requestId, data} = btpPacket.deserialize(message)
    const typeString = btpPacket.typeToString(type)

    if (!socketData.authorized) {
      // authentication handling must be done inside of the RPC module because
      // it happens on a per-socket basis rather than per plugin.
      this._handleAuth(socketIndex, { type, requestId, data })
      return
    }

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

  // authentication handling must be done in the RPC, because it's done
  // on a per-socket basis rather than a per-plugin basis.
  async _handleAuth (socketIndex, { type, requestId, data }) {
    const socketData = this._sockets[socketIndex]
    this.debug('authenticating socket #' + socketIndex)

    if (type !== btpPacket.TYPE_MESSAGE) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F01',
        name: 'InvalidFieldsError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'invalid method on unauthenticated socket' })
      }, requestId, []))
      return
    }

    if (data.protocolData[0].protocolName !== 'auth') {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F01',
        name: 'InvalidFieldsError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'auth must be primary protocol on unauthenticated message' })
      }, requestId, []))
      return
    }

    const [ authToken ] = data.protocolData.filter(p => p.protocolName === 'auth_token')
    if (!authToken) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F01',
        name: 'InvalidFieldsError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'missing "auth_token" secondary protocol' })
      }, requestId, []))
      return
    }

    const [ authUsername ] = data.protocolData.filter(p => p.protocolName === 'auth_username')
    if (!authToken) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F01',
        name: 'InvalidFieldsError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'missing "auth_username" secondary protocol' })
      }, requestId, []))
      return
    }

    const isValidAndAuthorized =
      authUsername.contentType === btpPacket.MIME_TEXT_PLAIN_UTF8 &&
      authToken.data.toString() === '' &&
      authToken.contentType === btpPacket.MIME_TEXT_PLAIN_UTF8 &&
      authToken.data.toString() === this._incomingAuthToken

    if (!isValidAndAuthorized) {
      this.debug(`responding to invalid auth token: ${authToken}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F00',
        name: 'NotAcceptedError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'invalid auth token and/or username' })
      }, requestId, []))
      return
    }

    await _send(socketData.socket, btpPacket.serializeResponse(requestId, []))
    socketData.authenticated = true
    this.debug('authenticated socket #' + socketIndex)
  }

  async _call (id, data) {
    if (!this._sockets.length) {
      this.debug('connecting socket')
      if (this._client) {
        await this._client.connect()
      } else {
        throw new Error('no connection')
      }
    }

    this.debug('sending ', Buffer.from(data).toString('hex'))
    await Promise.all(this._sockets.map(async (socketData) =>
      socketData.authorized && _send(socketData.socket, data)))

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

  disconnect () {
    this._sockets.map((socketData) => {
      socketData.socket.close()
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
  if (!socket ||
      typeof socket !== 'object' ||
      typeof socket.socket !== 'object' ||
      typeof socket.socket.send !== 'function' ||
      typeof socket.socket.on !== 'function') {
    throw new TypeError(`Argument expected to be a socket object.`)
  }
}
