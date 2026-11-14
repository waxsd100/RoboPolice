const cluster = require('cluster')
const sa = require('superagent')
const { redact } = require('../bot/utils/redact')

if (!cluster.isWorker && !process.env.DISCORD_WEBHOOK_URL && !process.env.BOT_TOKEN) {
  require('dotenv').config()
}

const MAX_DESCRIPTION_LENGTH = 4096
const MAX_TITLE_LENGTH = 256
const DEFAULT_AVATAR_URL = 'https://cdn4.iconfinder.com/data/icons/ionicons/512/icon-ios7-bell-512.png'

let globalHookErrors = 0
let warnedMissingUrl = false

setInterval(() => {
  if (globalHookErrors > 0) globalHookErrors-- // This timeout exists so that if the shard manager starts to spew errors, I don't get IP banned from Discord.
}, 5000).unref?.()

function getWebhookUrl () {
  if (process.env.DISCORD_WEBHOOK_URL) return process.env.DISCORD_WEBHOOK_URL
  if (!warnedMissingUrl) {
    warnedMissingUrl = true
    global.logger?.warn('Discord webhook url not specified, disabling webhook notifier.')
  }
  return null
}

function sanitizeDescription (msg, fallback = 'No message description provided.') {
  const raw = msg instanceof Error ? (msg.stack || msg.message || String(msg)) : String(msg ?? '')
  const clean = redact(raw).slice(0, MAX_DESCRIPTION_LENGTH)
  return clean || fallback
}

function fatal (message) {
  const url = getWebhookUrl()
  if (url && globalHookErrors < 5) {
    sa
      .post(url)
      .send({
        avatar_url: DEFAULT_AVATAR_URL,
        username: 'Fatal Error LoggerBot Webhook Notification',
        embeds: [{
          title: 'Fatal',
          description: sanitizeDescription(message),
          color: 16777215
        }]
      })
      .end(err => {
        if (err) globalHookErrors = globalHookErrors + 1
      })
  }
}

function error (message) {
  const url = getWebhookUrl()
  if (url && globalHookErrors < 5) {
    sa
      .post(url)
      .send({
        avatar_url: DEFAULT_AVATAR_URL,
        username: 'Error LoggerBot Webhook Notification',
        embeds: [{
          title: 'Error',
          description: sanitizeDescription(message),
          color: 16711680
        }]
      })
      .end(err => {
        if (err) globalHookErrors = globalHookErrors + 1
      })
  }
}

function warn (message) {
  const url = getWebhookUrl()
  if (url && globalHookErrors < 5) {
    sa
      .post(url)
      .send({
        avatar_url: DEFAULT_AVATAR_URL,
        username: 'Warning LoggerBot Webhook Notification',
        embeds: [{
          title: 'Warning',
          description: sanitizeDescription(message),
          color: 15466375
        }]
      })
      .end(err => {
        if (err) globalHookErrors = globalHookErrors + 1
      })
  }
}

function generic (message) {
  const url = getWebhookUrl()
  if (url && globalHookErrors < 5) {
    sa
      .post(url)
      .send({
        avatar_url: DEFAULT_AVATAR_URL,
        username: 'Generic LoggerBot Webhook Notification',
        embeds: [{
          title: 'Generic',
          description: sanitizeDescription(message),
          color: 6052351
        }]
      })
      .end(err => {
        if (err) globalHookErrors = globalHookErrors + 1
      })
  }
}

function custom (message) {
  const url = getWebhookUrl()
  if (url && globalHookErrors < 5) {
    sa
      .post(url)
      .send({
        avatar_url: message?.avatar_url || DEFAULT_AVATAR_URL,
        embeds: [{
          title: redact(String(message?.title || 'Custom Notification')).slice(0, MAX_TITLE_LENGTH),
          color: message?.color || 6052351,
          description: sanitizeDescription(message?.description)
        }],
        timestamp: new Date()
      })
      .end(err => {
        if (err) globalHookErrors = globalHookErrors + 1
      })
  }
}

exports.error = error
exports.warn = warn
exports.generic = generic
exports.fatal = fatal
exports.custom = custom
