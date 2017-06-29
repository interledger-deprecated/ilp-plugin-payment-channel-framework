const deepEqual = require('deep-equal')
const KEY_REGEX = /^[A-Za-z0-9\-_]*$/

class ObjTransferLog {
  constructor (store, opts) {
    this.maximum = +opts.maximum
    this.minimum = +opts.minimum
    this.cache = {}
    this.key = opts.key || ''
    if (!this.key.match(KEY_REGEX)) {
      throw new Error('invalid key: ' + this.key)
    }

    // optional, for stateful plugin only
    this.store = store
    this.writeQueue = Promise.resolve()

    // TODO: disable balance? (not needed for client plugin)
    this.balance_if = 0
    this.balance_i = 0
    this.balance_o = 0
    this.balance_of = 0
  }

  async connect () {
    if (this.connected) return

    if (this.store) {
      this.maximum = +(await this.store.get(this.key + ':tl:maximum')) || this.maximum
      this.minimum = +(await this.store.get(this.key + ':tl:minimum')) || this.minimum
      this.balance_if = +(await this.store.get(this.key + ':tl:balance:if')) || 0
      this.balance_of = +(await this.store.get(this.key + ':tl:balance:of')) || 0
      this.balance_i = this.balance_if
      this.balance_o = this.balance_of
    }

    this.connected = true
  }

  async setMaximum (n) {
    await this.connect()
    this.maximum = +n

    if (this.store) {
      this.writeQueue = this.writeQueue
        .then(() => {
          return this.store.put(this.key + ':tl:maximum', this.maximum)
        })

      await this.writeQueue
    }
  }

  async setMinimum (n) {
    await this.connect()
    this.minimum = +n

    if (this.store) {
      this.writeQueue = this.writeQueue
        .then(() => {
          return this.store.put(this.key + ':tl:minimum', this.minimum)
        })

      await this.writeQueue
    }
  }

  async getMaximum () {
    await this.connect()
    return String(this.maximum)
  }

  async getMinimum () {
    await this.connect()
    return String(this.minimum)
  }

  async getBalance () {
    await this.connect()
    return String(this.balance_if - this.balance_of)
  }

  async getIncomingFulfilled () {
    await this.connect()
    return String(this.balance_if)
  }

  async getOutgoingFulfilled () {
    await this.connect()
    return String(this.balance_of)
  }

  async getIncomingFulfilledAndPrepared () {
    await this.connect()
    return String(this.balance_i)
  }

  async getOutgoingFulfilledAndPrepared () {
    await this.connect()
    return String(this.balance_o)
  }

  async get (id) {
    await this.connect()
    // TODO: errors
    // - what if the transfer doesn't exist?
    return this.cache[id] ||
      (this.store && (await this.store.get(this.key + ':tl:transfer:' + id)))
  }

  async prepare (transfer, isIncoming) {
    await this.connect()
    // TODO: should direction be a boolean isIncoming?
    // TODO: errors
    // - what if goes over balance?
    // - what if id exists in DB already?
    // - what if the id exists and the contents are different?
    // TODO: should this auto-set the state field?

    const transferWithInfo = {
      transfer,
      isIncoming,
      state: 'prepared'
    }

    // TODO: more elegant way to fix race condition?
    let existing = this.cache[transferWithInfo.transfer.id]
    if (!existing) {
      this.cache[transferWithInfo.transfer.id] = transferWithInfo
      existing = (this.store && (await this.store.get(this.key + ':tl:transfer:' + transfer.id)))
      if (existing) {
        delete this.cache[transferWithInfo.transfer.id]
        return
      }
    }

    if (existing) {
      if (!deepEqual(existing.transfer, transferWithInfo.transfer)) {
        throw new Error('transfer ' + JSON.stringify(transferWithInfo) +
          ' matches the id of ' + JSON.stringify(existing) +
          ' but not the contents.')
      }
      return
    }

    const balance = isIncoming ? 'balance_i' : 'balance_o'
    const otherBalance = this[isIncoming ? 'balance_of' : 'balance_if']

    const amount = transferWithInfo.transfer.amount
    const isOver = isIncoming
      ? (n) => n - otherBalance > this.maximum
      : (n) => n - otherBalance > -this.minimum

    if (isOver(Number(amount) + Number(this[balance]))) {
      throw new Error(balance + ' exceeds greatest allowed value after: ' +
        JSON.stringify(transferWithInfo))
    }

    this[balance] += +transferWithInfo.transfer.amount
    this.cache[transferWithInfo.transfer.id] = transferWithInfo

    if (this.store) {
      this.writeQueue = this.writeQueue
        .then(() => {
          return this.store.put(this.key + ':tl:transfer:' + transfer.id,
            JSON.stringify(transferWithInfo))
        })

      await this.writeQueue
    }
  }

  async fulfill (transferId, fulfillment) {
    await this.connect()
    // TODO: errors
    // - what if a transfer is already fulfilled?
    // - what if transfer doesn't exist?
    // - should the fulfillment be validated?
    // - what if the transfer is rejected?
    const transferWithInfo = this.cache[transferId]
    const isIncoming = transferWithInfo.isIncoming
    const balance = isIncoming ? 'balance_if' : 'balance_of'

    if (transferWithInfo.state === 'prepared') {
      this[balance] += +transferWithInfo.transfer.amount
    }

    // TODO: should the failure state be rejected, like FBL API?
    if (transferWithInfo.state === 'cancelled') {
      throw new Error(transferId + ' cannot be fulfilled because it is rejected: ' +
        JSON.stringify(transferWithInfo))
    }

    transferWithInfo.state = 'fulfilled'
    transferWithInfo.fulfillment = fulfillment
    delete this.cache[transferId]

    if (this.store) {
      this.writeQueue = this.writeQueue
        .then(() => {
          return this.store.put(this.key + ':tl:transfer:' + transferWithInfo.transfer.id,
            JSON.stringify(transferWithInfo))
        }).then(() => {
          const balanceKey = isIncoming ? ':tl:balance:if' : ':tl:balance:of'
          return this.store.put(this.key + balanceKey, String(this[balance]))
        })

      await this.writeQueue
    }
  }

  // TODO: should there be some kind of rejectionReason field? it's useful in FBL.
  async cancel (transferId) {
    await this.connect()
    // TODO: errors
    // - what if a transfer is already cancelled?
    // - what if transfer doesn't exist?
    // - what if the transfer is fulfilled?
    const transferWithInfo = this.cache[transferId]
    const isIncoming = transferWithInfo.isIncoming
    const balance = isIncoming ? 'balance_i' : 'balance_o'

    if (transferWithInfo.state === 'prepared') {
      this[balance] -= +transferWithInfo.transfer.amount
    }

    // TODO: should the success state be executed, like FBL API?
    if (transferWithInfo.state === 'fulfilled') {
      throw new Error(transferId + ' cannot be rejected because it is fulfilled: ' +
        JSON.stringify(transferWithInfo))
    }

    transferWithInfo.state = 'cancelled'
    delete this.cache[transferId]

    if (this.store) {
      this.writeQueue = this.writeQueue
        .then(() => {
          return this.store.put(this.key + ':tl:transfer:' + transferId,
            JSON.stringify(transferWithInfo))
        })

      await this.writeQueue
    }
  }
}

class MaxValueTracker {
  constructor (store, opts) {
    this.highest = { value: '0', data: null }
    this.writeQueue = Promise.resolve()

    // TODO: load from store
    this.store = store
    this.key = opts.key || ''
    if (!this.key.match(KEY_REGEX)) {
      throw new Error('invalid key: ' + this.key)
    }
  }

  async connect () {
    if (this.connected) return
    if (this.store) {
      const storedHighest = await this.store.get(this.key + ':mvt:maximum')
      if (storedHighest) this.highest = JSON.parse(storedHighest)
    }

    this.connected = true
  }

  async setIfMax (entry) {
    await this.connect()

    if (!entry.value) {
      throw new Error('entry "' + JSON.stringify(entry) + '" must have a value')
    }

    const last = this.highest
    if (+entry.value > +last.value) {
      this.highest = entry

      if (this.store) {
        this.writeQueue = this.writeQueue
          .then(() => {
            return this.store.put(this.key + ':mvt:maximum', JSON.stringify({
              value: entry.value,
              data: entry.data
            }))
          })

        await this.writeQueue
      }

      return last
    }

    return entry
  }

  async getMax () {
    await this.connect()

    return this.highest
  }
}

module.exports = (store) => ({
  getTransferLog: (opts) => (new ObjTransferLog(store, opts)),
  getMaxValueTracker: (opts) => (new MaxValueTracker(store, opts))
})