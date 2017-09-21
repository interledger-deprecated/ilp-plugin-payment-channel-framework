'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const debug = require('debug')('ilp-plugin-payment-channel-framework:client')
const { URL } = require('url')

module.exports = class BtpClient {
  constructor ({ btpUri, plugin }) {
    this._plugin = plugin

    // The BTP URI must follow one of the following formats:
    // btp+wss://auth_username:auth_token@host:port/path
    // btp+wss://auth_username:auth_token@host/path
    // btp+ws://auth_username:auth_token@host:port/path
    // btp+ws://auth_username:auth_token@host/path
    // See also: https://github.com/interledger/rfcs/pull/300
    const parsedBtpUri = new URL(btpUri)
    this._authUsername = parsedBtpUri.username
    this._authToken = parsedBtpUri.password
    parsedBtpUri.username = ''
    parsedBtpUri.password = ''
    // Note that setting the parsedBtpUri.protocol does not work as expected,
    // so removing the 'btp+' prefix from the full URL here:
    assert(parsedBtpUri.toString().startsWith('btp+'), 'server uri must start with "btp+"')
    this._wsUri = parsedBtpUri.toString().substring('btp+'.length)
  }

  async connect () {
    debug('connecting to', this._wsUri)
    const ws = new WebSocket(this._wsUri)

    return new Promise((resolve, reject) => {
      ws.on('open', async () => {
        await this._plugin.addSocket(ws, this._authUsername, this._authToken)
        resolve()
      })

      ws.on('error', (err) => {
        reject(err)
      })
    })
  }
}
