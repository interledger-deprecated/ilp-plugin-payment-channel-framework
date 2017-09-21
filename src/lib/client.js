'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const debug = require('debug')('ilp-plugin-payment-channel-framework:client')
const { URL } = require('url')

module.exports = class BtpClient {
  constructor ({ server, secret, plugin, insecure }) {
    this._server = server
    this._plugin = plugin

    // The server URI must follow the format: btp+wss://host:port/path
    const parsedServer = new URL(server)
    assert(parsedServer.protocol.startsWith('btp+'), 'server uri must start with "btp+"')
    this._wsUri = (insecure ? 'ws://' : 'wss://') + parsedServer.host + parsedServer.path
    this._secret = (parsedServer.auth && parsedServer.auth.split(':')[1]) || secret

    if (!secret) {
      throw new Error('secret must be provided to BTP Client in the URL or in the configuration')
    }
  }

  async connect () {
    debug('connecting to', this._wsUri)
    const ws = new WebSocket(this._wsUri)

    return new Promise((resolve, reject) => {
      ws.on('open', async () => {
        await this._plugin.addSocket(ws, this._secret)
        resolve()
      })

      ws.on('error', (err) => {
        reject(err)
      })
    })
  }
}
