'use strict'

const chai = require('chai')
const assert = chai.assert

const Validator = require('../src/util/validator')

describe('validator', function () {
  beforeEach(() => {
    this.account = 'test.ledger.account'
    this.peer = 'test.ledger.peer'
    this.validator = new Validator({
      account: this.account,
      prefix: 'test.ledger.',
      peer: this.peer
    })
  })

  describe('assertOutgoing', () => {
    it('should accept matching accounts', () => {
      this.validator.assertOutgoing({
        to: this.peer,
        from: this.account
      })
    })

    it('should accept accounts with subledger components', () => {
      this.validator.assertOutgoing({
        to: this.peer + '.subledger',
        from: this.account
      })
    })

    it('should reject accounts that do not match', () => {
      assert.throws(() => this.validator.assertOutgoing({
        to: 'test.something.else',
        from: this.account
      }))
    })
  })

  describe('assertIncoming', () => {
    it('should accept matching accounts', () => {
      this.validator.assertIncoming({
        to: this.account,
        from: this.peer
      })
    })

    it('should accept accounts with subledger components', () => {
      this.validator.assertIncoming({
        to: this.account + '.subledger',
        from: this.peer
      })
    })

    it('should reject accounts that do not match', () => {
      assert.throws(() => this.validator.assertIncoming({
        to: this.account,
        from: 'test.something.else'
      }))
    })
  })
})
