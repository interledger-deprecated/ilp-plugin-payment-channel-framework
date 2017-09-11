'use strict'

const EventEmitter2 = require('eventemitter2')
const crypto = require('crypto')
const base64url = require('base64url')
const ilpPacket = require('ilp-packet')
const debug = require('debug')

const Clp = require('clp-packet')
const ClpRpc = require('../model/rpc')
const CustomRpc = require('../model/custom-rpc')
const Validator = require('../util/validator')
const getBackend = require('../util/backend')
const { protocolDataToIlpAndCustom, ilpAndCustomToProtocolData } =
  require('../util/protocolDataConverter')

const errors = require('../util/errors')
const NotAcceptedError = errors.NotAcceptedError
const InvalidFieldsError = errors.InvalidFieldsError
const AlreadyRejectedError = errors.AlreadyRejectedError
const AlreadyFulfilledError = errors.AlreadyFulfilledError
const RequestHandlerAlreadyRegisteredError = errors.RequestHandlerAlreadyRegisteredError

const assertOptionType = (opts, field, type) => {
  const val = opts[field]
  // eslint-disable-next-line valid-typeof
  if (!val || typeof val !== type) {
    throw new InvalidFieldsError('invalid "' + field + '"; got ' + val)
  }
}

const moduleName = (paymentChannelBackend) => {
  const pluginName = paymentChannelBackend.pluginName
  return 'ilp-plugin-' + pluginName.toLowerCase()
}

module.exports = class PluginPaymentChannel extends EventEmitter2 {
  constructor (paymentChannelBackend, opts) {
    super()
    const Backend = getBackend(opts._store)

    this._opts = opts
    this._stateful = !!(opts._backend || opts._store)
    this.debug = paymentChannelBackend
      ? debug(moduleName(paymentChannelBackend))
      : debug('ilp-plugin-virtual')

    if (!this._stateful && paymentChannelBackend) {
      throw new Error('if the plugin is stateless (no opts._store nor ' +
        'opts._backend), then a payment channel backend cannot be specified.')
    }

    if (this._stateful) {
      assertOptionType(opts, 'maxBalance', 'string')
      if (opts.minBalance) assertOptionType(opts, 'minBalance', 'string')

      this._backend = opts._backend || Backend
      this._maxBalance = opts.maxBalance
      this._minBalance = opts.minBalance

      this._transfers = this._backend.getTransferLog({
        maximum: this._maxBalance || 'Infinity',
        minimum: this._minBalance || '-Infinity',
        store: (opts._backend ? undefined : opts._store)
      })
    } else {
      this._transfers = Backend.getTransferLog({
        maximum: 'Infinity',
        minimum: '-Infinity'
      })
    }

    assertOptionType(opts, 'rpcUri', 'string')
    this._rpcUri = opts.rpcUri

    this._connected = false
    this._requestHandler = null
    this._sideProtoHandler = {}

    // register RPC methods
    this._rpc = new ClpRpc({
      rpcUri: this._rpcUri,
      plugin: this,
      debug: this.debug,
      handlers: {
        [Clp.TYPE_PREPARE]: this._handleTransfer.bind(this),
        [Clp.TYPE_FULFILL]: this._handleFulfillCondition.bind(this),
        [Clp.TYPE_REJECT]: this._handleRejectIncomingTransfer.bind(this),
        [Clp.TYPE_MESSAGE]: this._handleRequest.bind(this)
      }
    })

    if (this._stateful && paymentChannelBackend) {
      Validator.validatePaymentChannelBackend(paymentChannelBackend)

      this._paychan = paymentChannelBackend || {}
      this._paychanContext = {
        state: {},
        rpc: new CustomRpc({ clpRpc: this._rpc }),
        clpRpc: this._rpc,
        backend: this._backend,
        transferLog: this._transfers,
        plugin: this
      }

      this._paychan.constructor(this._paychanContext, opts)
      this.getInfo = () => JSON.parse(JSON.stringify(this._paychan.getInfo(this._paychanContext)))
      this.getAccount = () => this._paychan.getAccount(this._paychanContext)
      this.getPeerAccount = () => this._paychan.getPeerAccount(this._paychanContext)
      this._getAuthToken = () => this._paychan.getAuthToken(this._paychanContext)
    } else {
      assertOptionType(opts, 'token', 'string')
      assertOptionType(opts, 'prefix', 'string')

      this._info = opts.info
      this._peerAccountName = this._stateful ? 'client' : 'server'
      this._accountName = this._stateful ? 'server' : 'client'
      this._prefix = opts.prefix

      // payment channels aren't used in the asymmetric case so it's stubbed out
      this._paychanContext = {}
      this._paychan = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        handleIncomingPrepare: () => Promise.resolve(),
        createOutgoingClaim: () => Promise.resolve(),
        handleIncomingClaim: () => Promise.resolve()
      }

      this.getInfo = () => JSON.parse(JSON.stringify(this._info))
      this.getAccount = () => (this._prefix + this._accountName)
      this.getPeerAccount = () => (this._prefix + this._peerAccountName)
      this._getAuthToken = () => opts.token
    }

    this.addSocket = this._rpc.addSocket.bind(this._rpc)
    // this.receive = this._rpc.handleMessage.bind(this._rpc)
    this.isConnected = () => this._connected
    this.isAuthorized = (authToken) => (authToken === this._getAuthToken())
    this._rpc.setAuthToken(this._getAuthToken())
  }

  // don't throw errors even if the event handler throws
  // this is especially important in plugin virtual because
  // errors can prevent the balance from being updated correctly
  _safeEmit () {
    try {
      this.emit.apply(this, arguments)
    } catch (err) {
      this.debug('error in handler for event', arguments, err)
    }
  }

  // TODO: This function should be depcrecated from RFC-0004. Instead we should
  // use registerSideProtocolHandler. (@sharafian)
  registerRequestHandler (handler) {
    if (this._requestHandler) {
      throw new RequestHandlerAlreadyRegisteredError('requestHandler is already registered')
    }

    if (typeof handler !== 'function') {
      throw new InvalidFieldsError('requestHandler must be a function')
    }

    this._requestHandler = handler
  }

  deregisterRequestHandler () {
    this._requestHandler = null
  }

  async connect () {
    if (!this._stateful) {
      const clpResponse = await this._rpc.message({
        protocolData: [{
          protocolName: 'get_info',
          contentType: Clp.MIME_APPLICATION_JSON,
          data: Buffer.from('[]')
        }]
      })
      const resp = protocolDataToIlpAndCustom(clpResponse)
      this._info = (resp.custom && resp.custom.get_info) || {}
    }

    await this._paychan.connect(this._paychanContext)

    this._prefix = this.getInfo().prefix
    this._validator = new Validator({
      account: this.getAccount(),
      peer: this.getPeerAccount(),
      prefix: this.getInfo().prefix
    })

    this._connected = true
    this._safeEmit('connect')
  }

  async disconnect () {
    await this._paychan.disconnect(this._paychanContext)

    this._connected = false
    this._safeEmit('disconnect')
  }

  async sendRequest (message) {
    this.assertConnectionBeforeCalling('sendRequest')
    this._validator.validateOutgoingMessage(message)
    this._safeEmit('outgoing_request', message)

    this.debug('requesting with plugin', message)
    const clpResponse = await this._rpc.message({
      protocolData: ilpAndCustomToProtocolData(message)
    })

    const parsed = protocolDataToIlpAndCustom(clpResponse)

    parsed.to = this.getAccount()
    parsed.from = this.getPeerAccount()
    parsed.ledger = this._prefix
    this._validator.validateIncomingMessage(parsed)

    this._safeEmit('incoming_response', parsed)

    return parsed
  }

  async _handleRequest ({requestId, data}) {
    const message = Object.assign({
      id: requestId,
      to: this.getAccount(),
      from: this.getPeerAccount()
    }, protocolDataToIlpAndCustom(data))

    // if there are side protocols only
    if (message.custom && !message.ilp) {
      if (message.custom.get_info) {
        return [{
          protocolName: 'get_info',
          contentType: Clp.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(this.getInfo()))
        }]
      } else if (message.custom.get_balance) {
        return [{
          protocolName: 'get_balance',
          contentType: Clp.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(await this._handleGetBalance()))
        }]
      } else if (message.custom.get_limit) {
        return [{
          protocolName: 'get_limit',
          contentType: Clp.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(await this._handleGetLimit()))
        }]
      } else {
        if (this._paychanContext.rpc.handleProtocols) {
          return this._paychanContext.rpc.handleProtocols(message.custom)
        } else {
          throw new Error('Unsupported side protocol.')
        }
      }
    }

    this._validator.validateIncomingMessage(message)
    this._safeEmit('incoming_request', message)

    if (!this._requestHandler) {
      throw new NotAcceptedError('no request handler registered')
    }

    const response = await this._requestHandler(message)
      .catch((e) => ({
        ledger: message.ledger,
        to: this.getPeerAccount(),
        from: this.getAccount(),
        ilp: base64url(ilpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: this.getAccount(),
          forwardedBy: [],
          triggeredAt: new Date(),
          data: JSON.stringify({ message: e.message })
        }))
      }))

    this._validator.validateOutgoingMessage(response)
    this._safeEmit('outgoing_response', response)

    return ilpAndCustomToProtocolData(response)
  }

  async sendTransfer (preTransfer) {
    this.assertConnectionBeforeCalling('sendTransfer')
    const transfer = Object.assign({}, preTransfer, { ledger: this._prefix })
    this._validator.validateOutgoingTransfer(transfer)

    // apply the transfer before the other plugin can
    // emit any events about it. isIncoming = false.
    await this._transfers.prepare(transfer, false)

    try {
      await this._rpc.prepare(transfer, ilpAndCustomToProtocolData(transfer))
      this.debug('transfer acknowledged ' + transfer.id)
    } catch (e) {
      this.debug(e.name + ' during transfer ' + transfer.id)
      throw e
    }

    this._safeEmit('outgoing_prepare', transfer)
    if (this._stateful) {
      this._setupTransferExpiry(transfer.id, transfer.expiresAt)
    }
  }

  async _handleTransfer ({data}) {
    const transfer = Object.assign({
      id: data.id,
      amount: data.amount,
      executionCondition: data.executionCondition,
      expiresAt: data.expiresAt.toISOString(),
      to: this.getAccount(),
      from: this.getPeerAccount(),
      ledger: this._prefix
    }, protocolDataToIlpAndCustom(data))

    this._validator.validateIncomingTransfer(transfer)
    await this._transfers.prepare(transfer, true)

    try {
      await this._paychan.handleIncomingPrepare(this._paychanContext, transfer)
    } catch (e) {
      this.debug('plugin backend rejected incoming prepare:', e.message)
      await this._transfers.cancel(transfer.id)
      throw e
    }

    // set up expiry here too, so both sides can send the expiration message
    this._safeEmit('incoming_prepare', transfer)
    if (this._stateful) {
      this._setupTransferExpiry(transfer.id, transfer.expiresAt)
    }

    this.debug('acknowledging transfer id ', transfer.id)
  }

  async fulfillCondition (transferId, fulfillment) {
    this.assertConnectionBeforeCalling('fulfillCondition')
    this._validator.validateFulfillment(fulfillment)
    const transferInfo = await this._transfers.get(transferId)

    if (transferInfo.state === 'cancelled') {
      throw new AlreadyRejectedError(transferId + ' has already been cancelled: ' +
        JSON.stringify(transferInfo))
    }

    if (!transferInfo.isIncoming) {
      throw new Error(transferId + ' is outgoing; cannot fulfill')
    }

    if (new Date(transferInfo.transfer.expiresAt).getTime() < Date.now()) {
      throw new AlreadyRejectedError(transferId + ' has already expired: ' +
        JSON.stringify(transferInfo))
    }

    this._validateFulfillment(fulfillment, transferInfo.transfer.executionCondition)
    await this._transfers.fulfill(transferId, fulfillment)
    this._safeEmit('incoming_fulfill', transferInfo.transfer, fulfillment)
    const protocolData = []
    const result = await this._rpc.fulfill({
      id: transferId,
      fulfillment}, protocolData
    )

    const {custom} = protocolDataToIlpAndCustom(result)
    const claim = (custom && custom.claim) || {}

    try {
      await this._paychan.handleIncomingClaim(this._paychanContext, claim)
    } catch (e) {
      this.debug('error handling incoming claim:', e)
    }
  }

  async _handleFulfillCondition ({data}) {
    const transferId = data.id // TODO: useless rewrite

    this._validator.validateFulfillment(data.fulfillment)
    const transferInfo = await this._transfers.get(transferId)

    if (transferInfo.state === 'cancelled') {
      throw new AlreadyRejectedError(transferId + ' has already been cancelled: ' +
        JSON.stringify(transferInfo))
    }

    if (transferInfo.isIncoming) {
      throw new Error(transferId + ' is incoming; refusing to fulfill.')
    }

    if (new Date(transferInfo.transfer.expiresAt).getTime() < Date.now()) {
      throw new AlreadyRejectedError(transferId + ' has already expired: ' +
        JSON.stringify(transferInfo))
    }

    this._validateFulfillment(data.fulfillment, transferInfo.transfer.executionCondition)
    await this._transfers.fulfill(transferId, data.fulfillment)
    this._safeEmit('outgoing_fulfill', transferInfo.transfer, data.fulfillment)

    let result
    try {
      result = await this._paychan.createOutgoingClaim(
        this._paychanContext,
        await this._transfers.getOutgoingFulfilled())
    } catch (e) {
      this.debug('error creating outgoing claim:', e)
    }

    return result === undefined ? [] : ilpAndCustomToProtocolData({
      custom: {
        claim: result
      }
    })
  }

  // TODO: clarify the type of reason
  async rejectIncomingTransfer (transferId, reason) {
    this.assertConnectionBeforeCalling('rejectIncomingTransfer')
    this.debug('going to reject ' + transferId)
    const transferInfo = await this._transfers.get(transferId)

    if (transferInfo.state === 'fulfilled') {
      throw new AlreadyFulfilledError(transferId + ' has already been fulfilled: ' +
        JSON.stringify(transferInfo))
    }

    if (!transferInfo.isIncoming) {
      throw new Error(transferId + ' is outgoing; cannot reject.')
    }

    // TODO: add rejectionReason to interface
    await this._transfers.cancel(transferId, reason)
    this.debug('rejected ' + transferId)

    // const rejectionReason = ilpPacket.serializeIlpError({
    //   code: 'F00', // TODO: what should be the code? (cc: sharafian)
    //   name: 'Bad Request', // TODO: what should be the name?   (cc: sharafian)
    //   triggeredBy: this.getAccount(),
    //   forwardedBy: [],
    //   triggeredAt: new Date(),
    //   data: reason
    // })

    const rejectionReason = ilpPacket.serializeIlpError(reason)

    this._safeEmit('incoming_reject', transferInfo.transfer, reason)
    await this._rpc.reject({
      id: transferId,
      rejectionReason}, [])
  }

  async _handleRejectIncomingTransfer ({data}) {
    const transferId = data.id

    this.debug('handling rejection of ' + transferId)
    const transferInfo = await this._transfers.get(transferId)

    if (transferInfo.state === 'fulfilled') {
      throw new AlreadyFulfilledError(transferId + ' has already been fulfilled: ' +
        JSON.stringify(transferInfo))
    }

    if (transferInfo.isIncoming) {
      throw new Error(transferId + ' is incoming; peer cannot reject.')
    }

    // TODO: add rejectionReason to interface
    await this._transfers.cancel(transferId, data.reason)
    this.debug('peer rejected ' + transferId)

    this._safeEmit('outgoing_reject', transferInfo.transfer, data.reason)
  }

  async getBalance () {
    this.assertConnectionBeforeCalling('getBalance')
    if (this._stateful) {
      return this._transfers.getBalance()
    } else {
      return this.getPeerBalance()
    }
  }

  async _handleGetBalance () {
    return this._transfers.getBalance()
  }

  /* TODO: reassess whether this is ever needed
  async getFulfillment (transferId) {
    this.assertConnectionBeforeCalling('getFulfillment')
    if (this._stateful) {
      return this._transfers.getFulfillment(transferId)
    } else {
      return this._rpc.call('get_fulfillment', this._prefix, [ transferId ])
    }
  }
  */

  _setupTransferExpiry (transferId, expiresAt) {
    const expiry = Date.parse(expiresAt)
    const now = new Date()

    setTimeout(
      this._expireTransfer.bind(this, transferId),
      (expiry - now))
  }

  async _expireTransfer (transferId) {
    const transferInfo = await this._transfers.get(transferId)
    if (!transferInfo || transferInfo.state !== 'prepared') return

    this.debug('timing out ' + transferId)
    try {
      await this._transfers.cancel(transferId, 'expired')
    } catch (e) {
      this.debug('error expiring ' + transferId + ': ' + e.message)
      return
    }

    await this._rpc.reject({
      id: transferId,
      reason: {
        code: 'R00',
        name: 'Transfer Timed Out',
        triggeredBy: this.getAccount(),
        forwardedBy: [],
        triggeredAt: new Date(),
        data: 'expired'
      },
      protocolData: []
    }).catch(() => {})
    this._safeEmit((transferInfo.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      transferInfo.transfer)
  }

  async _handleExpireTransfer (transferId) {
    const transferInfo = await this._transfers.get(transferId)
    if (transferInfo.state !== 'prepared') return true

    if (Date.now() < Date.parse(transferInfo.transfer.expiresAt)) {
      throw new Error(transferId + ' doesn\'t expire until ' +
        transferInfo.transfer.expiresAt + ' (current time is ' +
        new Date().toISOString() + ')')
    }

    this.debug('timing out ' + transferId)
    try {
      await this._transfers.cancel(transferId, 'expired')
    } catch (e) {
      this.debug('error expiring ' + transferId + ': ' + e.message)
      return true
    }

    this._safeEmit((transferInfo.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      transferInfo.transfer)
    return true
  }

  async _handleGetLimit () {
    // TODO: add unit test
    return this._transfers.getMaximum()
  }

  _stringNegate (num) {
    if (isNaN(+num)) {
      throw new Error('invalid number: ' + num)
    } else if (num.charAt(0) === '-') {
      return num.substring(1)
    } else {
      return '-' + num
    }
  }

  async getLimit () {
    this.assertConnectionBeforeCalling('getLimit')
    const peerMaxBalance = await this._rpc.message({
      protocolData: [{
        protocolName: 'get_limit',
        contentType: Clp.MIME_APPLICATION_JSON,
        data: Buffer.from('[]')
      }]
    })
    const { custom } = (protocolDataToIlpAndCustom(peerMaxBalance))
    if (custom && custom.get_limit) {
      return this._stringNegate(custom.get_limit)
    } else {
      throw new Error('Failed to get limit of peer.')
    }
  }

  async getPeerBalance () {
    this.assertConnectionBeforeCalling('getPeerBalance')
    const clpResponse = await this._rpc.message({
      protocolData: [{
        protocolName: 'get_balance',
        contentType: Clp.MIME_APPLICATION_JSON,
        data: Buffer.from('[]')
      }]
    })

    const parsed = protocolDataToIlpAndCustom(clpResponse)
    const balance = parsed && parsed.custom && parsed.custom.get_balance
    if (!balance) {
      throw new Error('Could not get peer balance.')
    }

    return this._stringNegate(balance)
  }

  _validateFulfillment (fulfillment, condition) {
    this._validator.validateFulfillment(fulfillment)
    const hash = crypto.createHash('sha256')
    hash.update(fulfillment, 'base64')
    if (base64url(hash.digest()) !== condition) {
      throw new NotAcceptedError('Fulfillment does not match the condition')
    }
  }

  assertConnectionBeforeCalling (functionName) {
    if (!this._connected) {
      throw new Error(`Must be connected before ${functionName} can be called.`)
    }
  }
}
