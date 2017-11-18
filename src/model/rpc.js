const EventEmitter = require('events')
const btpPacket = require('btp-packet')
const assert = require('assert')
const crypto = require('crypto')

// TODO: make it configurable
const DEFAULT_TIMEOUT = 5000
const DEFAULT_AUTH_TIMEOUT = 2000
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
  constructor ({ client, plugin, handlers, authCheck, debug }) {
    assert(typeof handlers[btpPacket.TYPE_PREPARE] === 'function', 'Prepare handler missing')
    assert(typeof handlers[btpPacket.TYPE_FULFILL] === 'function', 'Fulfill handler missing')
    assert(typeof handlers[btpPacket.TYPE_REJECT] === 'function', 'Reject handler missing')
    assert(!client || typeof client === 'object', 'client must be an object')
    assert(typeof plugin === 'object', 'plugin must be provided')

    super()
    this._sockets = []
    this._handlers = handlers
    this._client = client
    this._plugin = plugin
    this._authCheck = authCheck
    this.debug = debug
  }

  async addSocket (socket, auth) {
    const newSocketIndex = this._sockets.length
    const weAreClient = Boolean(auth)
    if (weAreClient) {
      assert(typeof auth.username === 'string', 'auth.username should be a string (but empty string is allowed)')
      assert(typeof auth.token === 'string', 'auth.token should be a string (but empty string is allowed)')
    }
    _assertSocket({ socket, authenticated: weAreClient })

    this.debug('adding socket to a', weAreClient ? 'server' : 'client')

    // if we're the client on this socket, we don't need to receive
    // any authentication data. we have to send it instead.
    this._sockets.push({ socket, authenticated: weAreClient })
    socket.on('message', async (message) => {
      this.debug('got message:', Buffer.from(message).toString('hex'))
      try {
        await this.handleMessage(newSocketIndex, message)
      } catch (err) {
        this.debug(`RPC Error: ${err.message}. Message was ${JSON.stringify(message)}`)
      }
    })

    socket.on('close', (status) => {
      console.log('SOCKET CLOSE INFO:', Date.now(), status)
      this._deleteSocket(newSocketIndex)
    })

    // if this is a client, then send a special request with which to
    // authenticate.
    if (weAreClient) {
      const requestId = await _requestId()
      await _send(socket, btpPacket.serializeMessage(requestId, [{
        protocolName: 'auth',
        contentType: btpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from([])
      }, {
        protocolName: 'auth_username',
        contentType: btpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(auth.username, 'utf8')
      }, {
        protocolName: 'auth_token',
        contentType: btpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(auth.token, 'utf8')
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
    // if the socket isn't a client, we have to start a timeout
    // before which it must receive authentication.
    } else {
      return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          const socketData = this._sockets[newSocketIndex]
          if (socketData && !socketData.authenticated) {
            this.debug('timing out socket #' + newSocketIndex)
            this._deleteSocket(newSocketIndex)
            reject(new Error('client did not send correct auth message in time'))
          }
        }, DEFAULT_AUTH_TIMEOUT)
        this.on('authenticated', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  setAuthToken (token) {
    this._token = token
  }

  async handleMessage (socketIndex, message) {
    const socketData = this._sockets[socketIndex]
    _assertSocket(socketData)

    if (!socketData.authenticated) {
      // authentication handling must be done inside of the RPC module because
      // it happens on a per-socket basis rather than per plugin.
      this._handleAuth(socketIndex, message)
      return
    }

    const socket = socketData.socket
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

  // helper for handling authentication errors
  async _sendInvalidFieldsError (socket, requestId, message) {
    await _send(socket, btpPacket.serializeError({
      code: 'F01',
      name: 'InvalidFieldsError',
      triggeredAt: new Date(),
      data: JSON.stringify({ message })
    }, requestId, []))
      .catch((e) => {
        this.debug('warning, socket error:', e.message)
      })
  }

  _deleteSocket (socketIndex) {
    this._sockets[socketIndex].socket.close()
    // rather than splicing the socket out of the array of sockets
    // and causing all indices to be invalid, we just treat the
    // array like a map and delete the value corresponding to the
    // key that is index.
    delete this._sockets[socketIndex]
  }

  // authentication handling must be done in the RPC, because it's done
  // on a per-socket basis rather than a per-plugin basis.
  async _handleAuth (socketIndex, message) {
    const socketData = this._sockets[socketIndex]
    const {type, requestId, data} = btpPacket.deserialize(message)
    this.debug('authenticating socket #' + socketIndex)

    if (type !== btpPacket.TYPE_MESSAGE) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await this._sendInvalidFieldsError(socketData.socket, requestId,
        'invalid method on unauthenticated socket')
      this._deleteSocket(socketIndex)
      return
    }

    if (!data.protocolData.length || data.protocolData[0].protocolName !== 'auth') {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await this._sendInvalidFieldsError(socketData.socket, requestId,
        'auth must be primary protocol on unauthenticated message')
      this._deleteSocket(socketIndex)
      return
    }

    const [ authToken ] = data.protocolData.filter(p => p.protocolName === 'auth_token')
    if (!authToken) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await this._sendInvalidFieldsError(socketData.socket, requestId,
        'missing "auth_token" secondary protocol')
      this._deleteSocket(socketIndex)
      return
    }

    const [ authUsername ] = data.protocolData.filter(p => p.protocolName === 'auth_username')
    if (!authUsername) {
      this.debug(`responding to invalid auth request: ${JSON.stringify(data)}`)
      await this._sendInvalidFieldsError(socketData.socket, requestId,
        'missing "auth_username" secondary protocol')
      this._deleteSocket(socketIndex)
      return
    }

    const isValidAndAuthorized =
      authUsername.contentType === btpPacket.MIME_TEXT_PLAIN_UTF8 &&
      authToken.contentType === btpPacket.MIME_TEXT_PLAIN_UTF8 &&
      this._authCheck(authUsername.data.toString(), authToken.data.toString())

    if (!isValidAndAuthorized) {
      this.debug(`responding to invalid auth token: ${authToken}`)
      await _send(socketData.socket, btpPacket.serializeError({
        code: 'F00',
        name: 'NotAcceptedError',
        triggeredAt: new Date(),
        data: JSON.stringify({ message: 'invalid auth token and/or username' })
      }, requestId, []))
      this._deleteSocket(socketIndex)
      return
    }

    await _send(socketData.socket, btpPacket.serializeResponse(requestId, []))
    socketData.authenticated = true
    this.emit('authenticated')
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

    console.log('sending ', Buffer.from(data).toString('hex'))
    console.log('SOCKETS LENGTH:', this._sockets.length)
    await Promise.all(this._sockets.map(async (socketData) => {
      console.log('SOCKET:', socketData.socket.readyState)
      return socketData.authenticated && _send(socketData.socket, data)
    }))

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
        reject(new Error(id + ' timed out: ' + JSON.stringify(data)))
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
    try {
      socket.send(data, {binary: true}, (err) => {
        if (err) {
          reject(err)
        }
        resolve()
      })
    } catch (e) {
      reject(e)
    }
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
