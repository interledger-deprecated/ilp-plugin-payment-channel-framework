'use strict'

const Clp = require('clp-packet')
const base64url = require('base64url')

function protocolDataToIlpAndCustom ({ protocolData }) {
  const ret = {}

  for (const protocol of protocolData) {
    const name = protocol.protocolName
    if (name === 'ilp') {
      ret.ilp = base64url(protocol.data)
      continue
    }

    ret.custom = ret.custom || {}
    if (protocol.contentType === Clp.MIME_TEXT_PLAIN_UTF8) {
      ret.custom[name] = protocol.data.toString('utf8')
    } else if (protocol.contentType === Clp.MIME_APPLICATION_JSON) {
      ret.custom[name] = JSON.parse(protocol.data.toString('utf8'))
    } else {
      ret.custom[name] = protocol.data
    }
  }

  return ret
}

function ilpAndCustomToProtocolData ({ ilp, custom }) {
  const protocolData = []
  if (ilp) {
    protocolData.push({
      protocolName: 'ilp',
      contentType: Clp.MIME_APPLICATION_OCTET_STREAM,
      data: Buffer.from(ilp, 'base64')
    })
  }

  if (custom) {
    const sideProtocols = Object.keys(custom)
    for (const protocol of sideProtocols) {
      if (Buffer.isBuffer(custom[protocol])) {
        protocolData.push({
          protocolName: protocol,
          contentType: Clp.MIME_APPLICATION_OCTET_STREAM,
          data: custom[protocol]
        })
      } else if (typeof custom[protocol] === 'string') {
        protocolData.push({
          protocolName: protocol,
          contentType: Clp.MIME_TEXT_PLAIN_UTF8,
          data: Buffer.from(custom[protocol])
        })
      } else {
        protocolData.push({
          protocolName: protocol,
          contentType: Clp.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(custom[protocol]))
        })
      }
    }
  }

  return protocolData
}

module.exports = {
  protocolDataToIlpAndCustom,
  ilpAndCustomToProtocolData
}
