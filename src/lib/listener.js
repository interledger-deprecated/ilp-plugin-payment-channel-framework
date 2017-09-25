'use strict'

const assert = require('assert')
const debug = require('debug')('ilp-plugin-payment-channel-framework:listener')

module.exports = class BtpListener {
  constructor ({ plugin, socket }) {
    assert(typeof plugin === 'object', 'plugin must be provided')

    this._plugin = plugin
    this._socket = socket
  }

  listen () {
    debug('plugin instantiated server-side for incoming socket connection')
    return this._plugin.addSocket(this._socket)
  }
}
