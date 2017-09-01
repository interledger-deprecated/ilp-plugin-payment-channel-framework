'use strict'

const EventEmitter = require('events')
const clp = require('clp-packet')

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert

class MockSocket extends EventEmitter {
  constructor () {
    super()
    this.responses = []
    this.error = null
  }

  send (data, opts, cb) {
    setImmediate(() => {
      cb()

      setImmediate(() => {
        const clpEnvelope = clp.deserialize(data)
        const handler = this.responses.shift()

        if (!handler) {
          throw new Error('Missing mock request handler. ' +
            'Add request handlers with mockSocket.reply().')
        }
        try {
          const response = handler(clpEnvelope)
          if (response) {
            this.emit('message', response)
          }
        } catch (err) {
          this.error = err
          if (this.failure) {
            this.failure(err)
          } else { throw err }
        }

        if (this.responses.length === 0) {
          this.success && this.success()
        }
      })
    })
  }

  reply (expectedType, fn) {
    if (typeof expectedType !== 'number') {
      throw new TypeError('expectedType must be number')
    }
    const requiresReply = [clp.TYPE_PREPARE, clp.TYPE_FULFILL, clp.TYPE_REJECT,
      clp.TYPE_MESSAGE].includes(expectedType)
    if (!fn && requiresReply) {
      throw new TypeError('no request handler provided')
    }

    const handler = (clpEnvelope) => {
      const actualType = clpEnvelope.type
      assert.equal(actualType, expectedType,
        `Received CLP packet of type ${actualType}, but expected ${expectedType}`)

      if (fn) {
        return fn(clpEnvelope)
      }
    }

    this.responses.push(handler)
    return this
  }

  async isDone () {
    if (this.error) { return Promise.reject(this.error) }
    if (this.responses.length === 0) { return Promise.resolve(true) }

    // make sure all request handlers have been executed
    this.processed = new Promise((resolve, reject) => {
      this.success = resolve.bind(null, true)
      this.failure = reject
    })

    return this.processed
  }
}

module.exports = MockSocket
