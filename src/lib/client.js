'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const debug = require('debug')('ilp-plugin-payment-channel-framework:client')
const { URL } = require('url')

const CONNECT_RETRY_INTERVAL = 1000
const SEND_RETRY_INTERVAL = 100

module.exports = class BtpClient {
  constructor ({ server, plugin }) {
    this._plugin = plugin
    this.incarnation = 0

    // The BTP URI must follow one of the following formats:
    // btp+wss://auth_username:auth_token@host:port/path
    // btp+wss://auth_username:auth_token@host/path
    // btp+ws://auth_username:auth_token@host:port/path
    // btp+ws://auth_username:auth_token@host/path
    // See also: https://github.com/interledger/rfcs/pull/300
    const parsedBtpUri = new URL(server)
    this._authUsername = parsedBtpUri.username
    this._authToken = parsedBtpUri.password
    parsedBtpUri.username = ''
    parsedBtpUri.password = ''

    if (parsedBtpUri.protocol !== 'btp+wss:' && parsedBtpUri.protocol !== 'btp+ws:') {
      throw new Error('server protocol must be "btp+wss:" or "btp+ws:"')
    }

    // Note that setting the parsedBtpUri.protocol does not work as expected,
    // so removing the 'btp+' prefix from the full URL here:
    assert(parsedBtpUri.toString().startsWith('btp+'), 'server uri must start with "btp+"')
    this._wsUri = parsedBtpUri.toString().substring('btp+'.length)
  }

  tryToOpenWebSocketClient () {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUri, {
        perMessageDeflate: false
      })
      let hasBeenOpen = false
      ws.on('open', () => {
        hasBeenOpen = true
        resolve(ws)
      })
      ws.on('error', (err) => {
        if (hasBeenOpen) {
          console.error('WebSocket error', err)
        } else {
          reject(err)
        }
      })
      ws.on('close', () => {
        // automatically reconnect if server reboots
        if (hasBeenOpen && !ws.shouldClose) {
          this.ensureUpstream()
        }
      })
    })
  }

  getOpenWebSocketClient () {
    return new Promise((resolve) => {
      let done = false
      const tryOnce = async () => {
        let ws
        try {
          ws = await this.tryToOpenWebSocketClient()
        } catch (err) {
          console.error('error caught while trying to open WebSocket client', err)
          return
        }
        if (done) { // this can happen if opening the WebSocket works, but just takes long
          ws.shouldClose = true
          ws.close()
        } else {
          done = true
          clearInterval(timer)
          resolve(ws)
        }
      }
      let timer = setInterval(tryOnce, CONNECT_RETRY_INTERVAL)
      tryOnce()
    })
  }

  ensureUpstream () {
    return this.getOpenWebSocketClient().then(ws => {
      this.ws = ws
      ws.on('message', (msg) => {
        this.msgHandler(msg)
      })
      this.incarnation++
    }, (err) => {}) // eslint-disable-line handle-callback-err
  }

  async connect () {
    debug('connecting to', this._wsUri)
    await this.getOpenWebSocketClient()
    await this._plugin.addSocket({
      send: this.send.bind(this),
      on (eventName, handler) {
        if (eventName === 'message') {
          this.msgHandler[eventName] = handler
        }
      }
    }, this._authUsername, this._authToken)
  }

  send (msg) {
    return new Promise((resolve, reject) => {
      this.ws.send(msg, {}, (err) => {
        if (err) {
          setTimeout(() => {
            this.send(msg).then(resolve)
          }, SEND_RETRY_INTERVAL)
        } else {
          resolve()
        }
      })
    })
  }
}
