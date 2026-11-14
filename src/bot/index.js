const Eris = require('eris')
const cluster = require('cluster')
const redisLock = require('../db/interfaces/redis/redislock')
const indexCommands = require('../miscellaneous/commandIndexer')
const cacheGuildInfo = require('./utils/cacheGuildSettings')
const addBotListeners = require('./utils/addbotlisteners')

if (!cluster.isWorker && !process.env.BOT_TOKEN) {
  require('dotenv').config()
}

// How long a worker holds the Redis lock while its shards identify, so workers connect one at a time.
const CONNECT_LOCK_TTL_MS = 2000

function connect () {
  redisLock.lock('loggerinit', CONNECT_LOCK_TTL_MS).then(function (lock) {
    global.logger.startup(`Shards ${cluster.worker.rangeForShard} have obtained a lock and are connecting now.`)
    global.bot.connect()
    global.bot.once('ready', () => {
      lock.unlock().catch(function () {
        global.logger.warn(cluster.worker.rangeForShard + ' could not unlock, waiting')
      })
    })
  }).catch(e => {
    setTimeout(() => {
      connect()
    }, 10000)
  }) // throw out not being able to obtain a lock.
}

async function init () {
  global.logger.info('Shard init')
  global.redis = require('../db/clients/redis')
  global.bot = new Eris(process.env.BOT_TOKEN, {
    firstShardID: cluster.worker.shardStart,
    lastShardID: cluster.worker.shardEnd,
    maxShards: cluster.worker.totalShards,
    allowedMentions: {
      everyone: false,
      roles: false,
      users: false
    },
    restMode: true,
    messageLimit: 0,
    autoreconnect: 'auto',
    intents: [
      'guilds',
      'guildVoiceStates',
      'guildEmojis',
      'guildInvites',
      'guildMembers',
      'guildMessages',
      'guildBans',
      'guildPresences'
    ],
    defaultImageFormat: 'png'
  })

  global.bot.commands = {}
  global.bot.ignoredChannels = []
  global.bot.guildSettingsCache = {}

  indexCommands() // yes, block the thread while we read commands.
  await cacheGuildInfo()

  addBotListeners()

  connect()
}

let shuttingDown = false

async function gracefulShutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  global.logger.info(`${signal} caught. Flushing message batch, disconnecting bot, and closing database pool...`)
  try {
    global.bot?.disconnect?.({ reconnect: false })
  } catch (_) {}
  const { submitBatch } = require('../db/messageBatcher')
  await submitBatch(Infinity).catch(() => {})
  await Promise.resolve(require('../db/clients/postgres').end()).catch(() => {})
  process.exit(0)
}

process.on('exit', (code) => {
  if (!shuttingDown) {
    global.logger.error(`The process is exiting with code ${code}.`)
  }
})

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

process.on('unhandledRejection', (e) => {
  const msg = typeof e?.message === 'string' ? e.message : String(e ?? '')
  if (!msg.includes('[50013]') && !msg.includes('Request timed out') && !msg.startsWith('500 INTERNAL SERVER ERROR') && !msg.includes('503 Service Temporarily Unavailable') && !msg.includes('global ratelimit') && !msg.includes('hang up')) {
    global.logger.error(e)
  }
})

process.on('uncaughtException', (e) => {
  const msg = typeof e?.message === 'string' ? e.message : String(e ?? '')
  if (!msg.includes('[50013]') && !msg.includes('Request timed out') && !msg.startsWith('500 INTERNAL SERVER ERROR') && !msg.includes('503 Service Temporarily Unavailable') && !msg.includes('global ratelimit') && !msg.includes('hang up')) {
    global.logger.error(e)
  }
})

init()
