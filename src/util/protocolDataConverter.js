'use strict'

const Btp = require('btp-packet')
const base64url = require('base64url')

function protocolDataToProtocolMap (protocolData) {
  // For incoming BTP messages, do:
  // primary protocol:    how to handle:
  // auth                 answer without triggering request handler
  // info                 answer without triggering request handler
  // balance              answer without triggering request handler
  // paychan              answer without triggering request handler
  // ilp                  trigger request handler with message.ilp = base64url(data)
  // vouch                trigger request handler with message.custom = { vouch: base64url(data) }
  // other                trigger request handler with message.custom = { <other>: JSON.parse(data) }
  const protocolMap = {}

  for (const protocol of protocolData) {
    const name = protocol.protocolName

    if (protocol.contentType === Btp.MIME_TEXT_PLAIN_UTF8) {
      protocolMap[name] = protocol.data.toString('utf8')
    } else if (protocol.contentType === Btp.MIME_APPLICATION_JSON) {
      protocolMap[name] = JSON.parse(protocol.data.toString('utf8'))
    } else {
      protocolMap[name] = base64url(protocol.data)
    }
  }
  return protocolMap
}

function protocolMapToProtocolData (protocolMap) {
  // For outgoing BTP messages:
  // * ilp and custom.vouch, if present, are base64url-decoded and added as octet stream
  // * other entries in custom are JSON-stringified and added as JSON

  // trigger the registered request handler; they are:
  // * when info is the primary protocol
  // * when balance is the primary protocol
  // Then there is a second class, where the protocol is 'ilp'
  // They trigger the registered request handler, with message.ilp
  // All other message trigger it with message.custom.

  const protocolData = []

  const protocolNames = Object.keys(protocolMap)
  for (const protocolName of protocolNames) {
    if (['ilp', 'vouch'].indexOf(protocolName) !== -1) {
      protocolData.push({
        protocolName,
        contentType: Btp.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(protocolMap[protocolName], 'base64')
      })
    } else if (typeof protocolMap[protocolName] === 'string') {
      protocolData.push({
        protocolName,
        contentType: Btp.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(protocolMap[protocolName], 'utf8')
      })
    } else {
      protocolData.push({
        protocolName,
        contentType: Btp.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(protocolMap[protocolName]))
      })
    }
  }

  return protocolData
}

module.exports = {
  protocolDataToProtocolMap,
  protocolMapToProtocolData
}
