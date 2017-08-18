const EventEmitter = require('events')
const uuid = require('uuid')
const request = require('superagent')
const Clp = require('clp-packet')
const WebSocket = require('ws')

// TODO: make it configurable
const DEFAULT_TIMEOUT = 5000

module.exports = class ClpRpc extends EventEmitter {
  constructor ({ rpcUri, plugin, handlers, account }) {
    super()
    this._sockets = []
    this._handlers = handlers
    this._rpcUri = rpcUri
    this._account = account

    assert(typeof this._handlers[Clp.TYPE_PREPARE] === 'function', 'Prepare handler missing')
    assert(typeof this._handlers[Clp.TYPE_FULFILL] === 'function', 'Fulfill handler missing')
    assert(typeof this._handlers[Clp.TYPE_REJECT] === 'function', 'Reject handler missing')
    assert(typeof this._handlers[Clp.TYPE_MESSAGE] === 'function', 'Message handler missing')
  }

  addSocket (socket) {
    this._sockets.push(socket)
    socket.on('message', this.handleMessage.bind(this, socket))
  }

  async handleMessage (socket, message) {
    const { type, requestId } = Clp.readEnvelope(message)
    let parsed

    switch (type) {
      case Clp.TYPE_ACK:
      case Clp.TYPE_RESPONSE:
      case Clp.TYPE_ERROR:
        this.emit('_' + requestId, message)
        return

      case Clp.TYPE_PREPARE:
        parsed = Clp.deserializePrepare(message)
        break
      case Clp.TYPE_FULFILL:
        parsed = Clp.deserializeFulfill(message)
        break
      case Clp.TYPE_REJECT:
        parsed = Clp.deserializeReject(message)
        break
      case Clp.TYPE_MESSAGE:
        parsed = Clp.deserializeMessage(message)
        break

      default:
        throw new Error(type + ' is not a valid Clp message type')
    }

    try {
      const result = this.handlers[type].call(null, parsed)
      socket.send(Clp.serializeResponse(requestId, result || []))
    } catch (e) {
      socket.send(Clp.serializeError({
        rejectionReason: {
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: this._account,
          forwardedBy: [],
          triggeredAt: new Date(),
          data: JSON.stringify({ message: e.message })
        }
      }, requestId, []))
    }
  }

  async _call (id, data) {
    if (!this.sockets.length) {
      await this._connect()
    }

    await Promise.all(this.sockets.map(async (socket) => socket.send(data)))

    const response = new Promise((resolve, reject) => {
      this.once('_' + id, (message) => {
        const type = message[0]
        switch (type) {
          case Clp.TYPE_ACK:
            resolve(Clp.deserializeAck(message))
            break
          case Clp.TYPE_RESPONSE:
            resolve(Clp.deserializeResponse(message))
            break
          case Clp.TYPE_ERROR:
            reject(new Error(JSON.stringify(Clp.deserializeResponse(message))))
            break
        }
      })
    })

    const timeout = new Promise((resolve, reject) =>
      setTimeout(() => reject(new Error(id + ' timed out')), DEFAULT_TIMEOUT))

    return Promise.race([
      response,
      timeout
    ])
  }

  async prepare ({ id, amount, executionCondition, expiresAt, protocolData }) {
    const requestId = uuid()
    const prepareRequest = Clp.serializePrepare({
        id, amount, executionCondition, expiresAt
      }, requestId, protocolData)

    return _call(requestId, prepareRequest)
  }

  async fulfill ({ id, fulfillment, protocolData }) {
    const requestId = uuid()
    const fulfillRequest = Clp.serializeFulfill({
        id, fulfillment
      }, requestId, protocolData)

    return _call(requestId, fulfillRequest)
  }

  async reject ({ id, reason, protocolData }) {
    const requestId = uuid()
    const rejectRequest = Clp.serializeReject({
        id, reason
      }, requestId, protocolData)

    return _call(requestId, rejectRequest)
  }

  async message ({ protocolData }) {
    const requestId = uuid()
    const messageRequest = Clp.serializeReject(requestId, protocolData)

    return _call(requestId, messageRequest)
  }

  async _connect () {
    const ws = new WebSocket(this._rpcUri)
    return new Promise((resolve) => {
      ws.on('open', () => resolve())
    })
  }

  disconnect () {
    this.sockets.map((socket) => {
      socket.close()
    })
    this.sockets = []
  }
}
