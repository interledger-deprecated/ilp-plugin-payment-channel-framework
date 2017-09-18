const Btp = require('btp-packet')

module.exports = class CustomRpc {
  constructor ({ btpRpc }) {
    this._btpRpc = btpRpc
    this._methods = {}
  }

  // prefix argument is included for backwards-compatibility
  async call (method, prefix, args) {
    const response = await this._btpRpc.message(
      [{
        protocolName: method,
        contentType: Btp.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(args))
      }]
    )

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
      const response = await this._methods[protocol].call(this, custom[protocol])

      responseProtocolData.push({
        protocolName: protocol,
        contentType: Btp.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(response))
      })
    }
    return responseProtocolData
  }
}
