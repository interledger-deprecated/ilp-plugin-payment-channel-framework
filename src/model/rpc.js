const EventEmitter = require('events')
const request = require('superagent')

// TODO: really call it HTTP RPC?
module.exports = class HttpRpc extends EventEmitter {
  constructor ({ rpcUris, plugin, tolerateFailure, debug }) {
    super()
    this._methods = {}
    this.debug = debug
    this._plugin = plugin
    this.rpcUris = rpcUris
    this.tolerateFailure = tolerateFailure
  }

  addMethod (name, handler) {
    this._methods[name] = handler
  }

  async receive (method, params) {
    // TODO: 4XX when method doesn't exist
    this.debug('incoming', method, 'from', this.rpcUris, 'with', params)
    if (!this._methods[method]) {
      throw new Error('no method "' + method + '" found.')
    }

    return this._methods[method].apply(this._plugin, params)
  }

  async call (method, prefix, params) {
    const results = await Promise.all(this.rpcUris.map((uri) => {
      this.debug('outgoing', method, 'to', uri, 'with', params)
      return this._callUri(uri, method, prefix, params)
        .catch((e) => {
          if (!this.tolerateFailure) throw e
        })
    }))

    return results.reduce((a, r) => {
      if (a) this.debug('got RPC result:', a)
      return a || r
    })
  }

  async _callUri (rpcUri, method, prefix, params) {
    this.debug('calling', method, 'with', params)

    const authToken = this._plugin._getAuthToken()
    const uri = rpcUri + '?method=' + method + '&prefix=' + prefix
    const result = await Promise.race([
      request
        .post(uri)
        .set('Authorization', 'Bearer ' + authToken)
        .send(params),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('request to ' + uri + ' timed out.'))
        }, 2000)
      })
    ])

    // 401 is a common error when a peering relationship isn't mutual, so a more
    // helpful error is printed.
    if (result.statusCode === 401) {
      throw new Error('Unable to call "' + rpcUri +
        '" (401 Unauthorized). They may not have you as a peer. (error body=' +
        JSON.stringify(result.body) + ')')
    }

    if (result.statusCode !== 200) {
      throw new Error('Unexpected status code ' + result.statusCode + ' from ' + rpcUri + ', with body "' +
        JSON.stringify(result.body) + '"')
    }

    return result.body
  }
}
