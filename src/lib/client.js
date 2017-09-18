'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const debug = require('debug')('ilp-plugin-payment-channel-framework:client')

module.exports = class BtpClient {
  constructor ({ server, plugin }) {
    this._server = server
    this._plugin = plugin
  }

  async connect () {
    // The server URI must follow the format: btp+wss://host:port/path
    // See also: https://github.com/interledger/interledger/wiki/Interledger-over-BTP
    assert(this._server.slice(0, 4) === 'btp+', 'server uri must start with "btp+"')

    const uri = this._server.slice(4)

    debug('connecting to', uri)
    const ws = new WebSocket(uri)

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        this._plugin.addSocket(ws)
        resolve()
      })

      ws.addEventListener('error', (err) => {
        reject(err)
      })
    })
  }
}
