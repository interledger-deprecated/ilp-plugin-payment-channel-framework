'use strict'

const EventEmitter2 = require('eventemitter2')
const crypto = require('crypto')
const base64url = require('base64url')
const ilpPacket = require('ilp-packet')
const debug = require('debug')
const int64 = require('../util/int64')

const Btp = require('btp-packet')
const BtpRpc = require('../model/rpc')
const BtpClient = require('./client')
const BtpListener = require('./listener')
const CustomRpc = require('../model/custom-rpc')
const Validator = require('../util/validator')
const getBackend = require('../util/backend')
const { protocolDataToIlpAndCustom, ilpAndCustomToProtocolData } =
  require('../util/protocolDataConverter')

const errors = require('../util/errors')
const NotAcceptedError = errors.NotAcceptedError
const InvalidFieldsError = errors.InvalidFieldsError
const AlreadyRolledBackError = errors.AlreadyRolledBackError
const AlreadyFulfilledError = errors.AlreadyFulfilledError
const RequestHandlerAlreadyRegisteredError = errors.RequestHandlerAlreadyRegisteredError

// TODO: What should the default port be?
const DEFAULT_PORT = 4195

const INFO_REQUEST_ACCOUNT = 0 // eslint-disable-line no-unused-vars
const INFO_REQUEST_FULL = 2
const BALANCE_REQUEST = 0
const LIMIT_REQUEST = 0

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

class PluginPaymentChannel extends EventEmitter2 {

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

    this._connected = false
    this._connecting = false
    this._requestHandler = null
    this._sideProtoHandler = {}

    if (opts.server) {
      assertOptionType(opts, 'server', 'string')
      this._client = new BtpClient({
        server: opts.server,
        plugin: this
      })
    } else {
      this._client = null
    }

    if (opts.listener) {
      assertOptionType(opts, 'listener', 'object')

      this._listener = new BtpListener({
        plugin: this,
        port: opts.listener.port || DEFAULT_PORT,
        cert: opts.listener.cert,
        key: opts.listener.key,
        ca: opts.listener.ca
      })
      this._listener.listen()
    } else {
      this._listener = null
    }

    // register RPC methods
    this._rpc = new BtpRpc({
      plugin: this,
      debug: this.debug,
      client: this._client,
      handlers: {
        [Btp.TYPE_PREPARE]: this._handleTransfer.bind(this),
        [Btp.TYPE_FULFILL]: this._handleFulfillCondition.bind(this),
        [Btp.TYPE_REJECT]: this._handleRejectIncomingTransfer.bind(this),
        [Btp.TYPE_MESSAGE]: this._handleRequest.bind(this)
      },
      // checks the token with which incoming sockets are authenticated. If there
      // is no listener, and addSocket will not be called for incoming
      // BTP connections, then this argument is unnecessary.
      authCheck: (opts.authCheck || function (username, token) {
        return (username === '' && token === opts.incomingSecret)
      })
    })

    if (this._stateful && paymentChannelBackend) {
      Validator.validatePaymentChannelBackend(paymentChannelBackend)

      this._paychan = paymentChannelBackend || {}
      this._paychanContext = {
        state: {},
        rpc: new CustomRpc({ btpRpc: this._rpc }),
        btpRpc: this._rpc,
        backend: this._backend,
        transferLog: this._transfers,
        plugin: this
      }

      this._paychan.constructor(this._paychanContext, opts)
      this.getInfo = () => JSON.parse(JSON.stringify(this._paychan.getInfo(this._paychanContext)))
      this._prefix = opts.prefix
      this._info = this.getInfo()

      this._getAuthToken = () => this._paychan.getAuthToken(this._paychanContext)
    } else {
      this._info = opts.info || null

      this._peerAccountName = this._stateful ? 'client' : 'server'
      this._accountName = this._stateful ? 'server' : 'client'

      // payment channels aren't used in the asymmetric case so it's stubbed out
      this._paychanContext = {}
      this._paychan = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        handleIncomingPrepare: () => Promise.resolve(),
        createOutgoingClaim: () => Promise.resolve(),
        handleIncomingClaim: () => Promise.resolve()
      }

      this.getInfo = () => this._info && JSON.parse(JSON.stringify(this._info))
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

  async connect () {
    if (this._connected) return
    if (this._connecting) return this._connectPromise
    this._connecting = true

    let finishConnectPromise
    this._connectPromise = new Promise((resolve) => {
      finishConnectPromise = resolve
    })

    try {
      if (!this._info) {
        this.debug('info not available locally, loading remotely')
        const btpResponse = await this._rpc.message(
          [{
            protocolName: 'info',
            contentType: Btp.MIME_APPLICATION_OCTET_STREAM,
            data: Buffer.from([ INFO_REQUEST_FULL ])
          }]
        )
        const resp = protocolDataToIlpAndCustom(btpResponse)
        this._info = (resp.protocolMap && resp.protocolMap.info) || {}
      }

      await this._paychan.connect(this._paychanContext)
    } catch (err) {
      debug('connect failed:', err)
      this._connected = false
      throw err
    }
    this._validator = new Validator()

    this._connected = true
    this._connecting = false
    this._safeEmit('connect')
    finishConnectPromise()
  }

  async disconnect () {
    if (!this._connected) return
    this._connected = false

    await this._paychan.disconnect(this._paychanContext)

    if (this._listener) {
      this._listener.close()
    }
    this._safeEmit('disconnect')
  }

  async sendTransfer (preTransfer) {
    this.assertConnectionBeforeCalling('sendTransfer')
    const transfer = Object.assign({}, preTransfer)
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

    return new Promise((resolve, reject) => {
      const that = this

      function cleanUp () {
        setImmediate(() => {
          that.removeListener('outgoing_reject', onReject)        
          that.removeListener('outgoing_fulfill', onFulfill)
        })
      }

      function onReject (_transfer, reason) {
        if (_transfer.id !== transfer.id) return
        cleanUp()
        reject(new InterledgerError(transfer, reason))
      }

      function onFulfill (transfer, fulfillment, data) {
        if (_transfer.id !== transfer.id) return
        cleanUp()
        resolve({ fulfillment, data })
      }

      that.on('outgoing_reject', onReject)
      that.on('outgoing_fulfill', onFulfill)
    })
  }

  async _handleTransfer ({data}) {
    const { ilp, custom } = protocolDataToIlpAndCustom(data)
    const transfer = {
      id: data.id,
      amount: data.amount,
      executionCondition: data.executionCondition,
      expiresAt: data.expiresAt.toISOString()
    }

    if (ilp) transfer.ilp = ilp
    if (custom) transfer.custom = custom

    this._validator.validateIncomingTransfer(transfer)
    await this._transfers.prepare(transfer, true)

    try {
      await this._paychan.handleIncomingPrepare(this._paychanContext, transfer)
    } catch (e) {
      this.debug('plugin backend rejected incoming prepare:', e.message)
      await this._transfers.cancel(transfer.id)
      throw e
    }

    this._safeEmit('incoming_prepare', transfer)

    // set up expiry here too, so both sides can send the expiration message
    let response
    try {
      response = await Promise.race([
        this._transferHandler(transfer),
        this._expireTransfer(transfer.id)
      ])
    } catch (e) {
      await this.rejectIncomingTransfer(transfer.id, e.reason)
      return
    }

    // fulfillmentInfo: { fulfillment (base64url), data (base64url) }
    await this.fulfillCondition(transfer.id, response.fulfillment, response.data)
  }

  async fulfillCondition (transferId, fulfillment) {
    this.assertConnectionBeforeCalling('fulfillCondition')
    this._validator.validateFulfillment(fulfillment)
    const transferInfo = await this._transfers.get(transferId)

    if (transferInfo.state === 'cancelled') {
      throw new AlreadyRolledBackError(transferId + ' has already been cancelled: ' +
        JSON.stringify(transferInfo))
    }

    if (!transferInfo.isIncoming) {
      throw new Error(transferId + ' is outgoing; cannot fulfill')
    }

    if (new Date(transferInfo.transfer.expiresAt).getTime() < Date.now()) {
      throw new AlreadyRolledBackError(transferId + ' has already expired: ' +
        JSON.stringify(transferInfo))
    }

    this._validateFulfillment(fulfillment, transferInfo.transfer.executionCondition)
    await this._transfers.fulfill(transferId, fulfillment)
    this._safeEmit('incoming_fulfill', transferInfo.transfer, fulfillment)
    const protocolData = []
    const result = await this._rpc.fulfill(transferId, fulfillment, protocolData)

    const { protocolMap } = protocolDataToIlpAndCustom(result)
    const { claim } = protocolMap || {}

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
      throw new AlreadyRolledBackError(transferId + ' has already been cancelled: ' +
        JSON.stringify(transferInfo))
    }

    if (transferInfo.isIncoming) {
      throw new Error(transferId + ' is incoming; refusing to fulfill.')
    }

    if (new Date(transferInfo.transfer.expiresAt).getTime() < Date.now()) {
      throw new AlreadyRolledBackError(transferId + ' has already expired: ' +
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
      protocolMap: {
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

    const rejectionReason = ilpPacket.serializeIlpError({
      code: reason.code,
      name: reason.name,
      triggeredBy: reason.triggered_by,
      forwardedBy: reason.forwarded_by,
      triggeredAt: reason.triggered_at,
      data: JSON.stringify(reason.additional_info)
    })

    this._safeEmit('incoming_reject', transferInfo.transfer, reason)
    await this._rpc.reject(transferId, [{
      protocolName: 'ilp',
      contentType: Btp.MIME_APPLICATION_OCTET_STREAM,
      data: rejectionReason
    }])
  }

  async _handleRejectIncomingTransfer ({data}) {
    const transferId = data.id
    const { ilp } = protocolDataToIlpAndCustom(data)
    const packet = ilpPacket.deserializeIlpPacket(Buffer.from(ilp, 'base64')).data
    const rejectionReason = {
      code: packet.code,
      name: packet.name,
      triggered_by: packet.triggeredBy,
      forwarded_by: packet.forwardedBy,
      triggered_at: packet.triggeredAt
    }
    try {
      rejectionReason.additional_info = JSON.parse(packet.data)
    } catch (e) {
      rejectionReason.additional_info = 'not JSON'
    }

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
    await this._transfers.cancel(transferId, rejectionReason)
    this.debug('peer rejected ' + transferId)

    this._safeEmit('outgoing_reject', transferInfo.transfer, rejectionReason)
  }

  validateFulfillment (fulfillment, condition) {
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

PluginPaymentChannelFramework.lpiVersion = 2
module.exports = PluginPaymentChannelFramework
