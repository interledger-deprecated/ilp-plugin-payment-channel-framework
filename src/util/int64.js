function toBuffer (str) {
  let buf = Buffer.from([ 0, 0, 0, 0, 0, 0, 0, 0 ])
  let cursor = 0
  let negative = false
  if (str[0] === '-') {
    negative = true
    buf = Buffer.from([ 255, 255, 255, 255, 255, 255, 255, 255 ])
    cursor++
  }
  // TODO: support big numbers
  const num = parseInt(str.substring(cursor))
  let hex = num.toString(16)
  if (hex.length % 2 === 1) {
    hex = '0' + hex
  }
  const bytes = Buffer.from(hex, 'hex')
  const offset = 8 - bytes.length
  for (let i = 0; i < bytes.length; i++) {
    if (negative) {
      buf[offset + i] = 255 - bytes[i]
    } else {
      buf[offset + i] = bytes[i]
    }
  }
  return buf
}

function toString (buf) {
  let sign = ''
  if (buf[0] > 127) {
    sign = '-'
    for (let i = 0; i < buf.length; i++) {
      buf[i] = 255 - buf[i]
    }
  }
  const hex = buf.toString('hex')
  const num = parseInt(hex, 16)
  const str = sign + num.toString()
  return str
}

module.exports = {
  toBuffer,
  toString
}
