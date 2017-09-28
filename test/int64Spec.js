'use strict'

const chai = require('chai')
const assert = chai.assert

const int64 = require('../src/util/int64')

describe('int64', function () {
  beforeEach(() => {
    // TODO: test big numbers

    this.positiveStrings = [ '5', '256', '260', '1100', '234523452' ]

    this.negativeStrings = this.positiveStrings.map(str => '-' + str)

    this.positiveBuffers = [
      Buffer.from('00 00 00 00 00 00 00 05'.replace(/ /g, ''), 'hex'),
      Buffer.from('00 00 00 00 00 00 01 00'.replace(/ /g, ''), 'hex'),
      Buffer.from('00 00 00 00 00 00 01 04'.replace(/ /g, ''), 'hex'),
      Buffer.from('00 00 00 00 00 00 04 4c'.replace(/ /g, ''), 'hex'),
      Buffer.from('00 00 00 00 0d fa 8b 3c'.replace(/ /g, ''), 'hex')
    ]

    this.negativeBuffers = [
      Buffer.from('ff ff ff ff ff ff ff fa'.replace(/ /g, ''), 'hex'),
      Buffer.from('ff ff ff ff ff ff fe ff'.replace(/ /g, ''), 'hex'),
      Buffer.from('ff ff ff ff ff ff fe fb'.replace(/ /g, ''), 'hex'),
      Buffer.from('ff ff ff ff ff ff fb b3'.replace(/ /g, ''), 'hex'),
      Buffer.from('ff ff ff ff f2 05 74 c3'.replace(/ /g, ''), 'hex')
    ]
  })

  describe('positive numbers from string', () => {
    beforeEach(() => {
      this.results = this.positiveStrings.map(str => int64.toBuffer(str))
    })
    it('should create the correct buffers', () => {
      assert.deepEqual(this.results, this.positiveBuffers)
    })
  })

  describe('negative numbers from string', () => {
    beforeEach(() => {
      this.results = this.negativeStrings.map(str => int64.toBuffer(str))
    })
    it('should create the correct buffers', () => {
      assert.deepEqual(this.results, this.negativeBuffers)
    })
  })

  describe('positive numbers to string', () => {
    beforeEach(() => {
      this.results = this.positiveBuffers.map(buf => int64.toString(buf))
    })
    it('should give the correct strings', () => {
      assert.deepEqual(this.results, this.positiveStrings)
    })
  })

  describe('negative numbers to string', () => {
    beforeEach(() => {
      this.results = this.negativeBuffers.map(buf => int64.toString(buf))
    })
    it('should give the correct strings', () => {
      assert.deepEqual(this.results, this.negativeStrings)
    })
  })
})
