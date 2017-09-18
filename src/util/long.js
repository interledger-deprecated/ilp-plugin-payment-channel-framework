const BigNumber = require('bignumber.js')
const { Reader, Writer } = require('oer-utils')

function longToBuffer (_n) {
  const n = new BigNumber(_n)
  const high = n.div(0x100000000)
  const low = n.mod(0x100000000)

  const writer = new Writer()
  writer.writeUInt64([ high, low ])
  return writer.getBuffer()
}

function bufferToLong (buffer) {
  const reader = new Reader(buffer)
  const [ high, low ] = reader.readUInt64()

  const longHigh = new BigNumber(high)
  return longHigh
    .mul(0x100000000)
    .add(low)
}

module.exports = {
  longToBuffer,
  bufferToLong
}
