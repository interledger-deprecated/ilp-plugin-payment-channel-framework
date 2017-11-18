'use strict'

const assert = require('chai').assert
const expect = require('chai').expect

const getObjBackend = require('../src/util/backend')
const PluginPaymentChannel = require('..')
const options = {
  prefix: 'example.red.',
  maxBalance: '1000',
  server: 'btp+wss://user:placeholder@example.com/rpc',
  _backend: getObjBackend(null)
}

describe.skip('constructor', () => {
  it('should be a function', () => {
    assert.isFunction(PluginPaymentChannel)
  })

  it('should return an object', () => {
    assert.isObject(new PluginPaymentChannel(options))
  })

  const omitField = (field) => {
    it('should give an error without ' + field, () => {
      expect(() => new PluginPaymentChannel(Object.assign(options, { [field]: undefined })))
        .to.throw(Error)
    })
  }

  omitField('maxBalance')
  omitField('secret')
  omitField('peerPublicKey')
  omitField('_store')
  omitField('rpcUri')

  it('should give an error with incorrect prefix passed in', () => {
    expect(() => new PluginPaymentChannel(Object.assign({}, options, {prefix: 'trash.'})))
      .to.throw(Error)
  })
})
