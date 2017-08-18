const Clp = require('clp-packet')

module.exports = class CustomRpc extends EventEmitter {
  constructor ({ clpRpc }) {
    this._clpRpc = clpRpc
    this._methods = {}
  }

  // prefix argument is included for backwards-compatibility
  async call (method, prefix, args) {
    const response = await this._clpRpc.message({
      protocolData: [{
        protocolName: method,
        contentType: Clp.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(args))
      }]
    })

    // TODO: handle errors
    return JSON.parse(Buffer.from(response.protocolData[method], 'utf8'))
  }

  addMethod (protocol, method) {
    this._methods[protocol] = method
  }

  async handleProtocols (custom) {
    const responseProtocolData = []

    for (const protocol of Object.keys(custom)) {
      // TODO: define custom error code for unsupported side protocol
      if (!this._methods[protocol]) throw new Error('Unrecognized side protocol: ' + protocol)
      const response = await this._methods[protocol].call(this._that, ...custom[protocol])

      responseProtocolData.push({
        protocolName: protocol
        contentType: Clp.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(response))
      })
    }
    
    return responseProtocolData
  }
}
