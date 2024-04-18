const Eris = require('eris')
const Sentry = require('@sentry/node')
const indexCommands = require('../miscellaneous/commandIndexer')
const cacheGuildInfo = require('./utils/cacheGuildSettings')
const addBotListeners = require('./utils/addbotlisteners')
const { generateTables } = require('../miscellaneous/generateDB')
const logger = require('../miscellaneous/logger')

require('dotenv').config()

if (process.env.SENTRY_URI) {
  Sentry.init({
    dsn: process.env.SENTRY_URI,
    maxBreadcrumbs: 1
  })
} else {
  global.logger.warn('No Sentry URI provided. Error logging will be restricted to messages only.')
}

async function init () {
  global.logger.info('Logger is starting up...')
  global.redis = require('../db/clients/redis')
  global.bot = new Eris(process.env.BOT_TOKEN, {
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
      'messageContent',
      'guildBans'
    ],
    defaultImageFormat: 'png'
  })

  global.bot.editStatus('dnd', {
    name: 'Bot is booting'
  })

  try {
    await generateTables()
  } catch (e) {
    logger.error(e)
    process.exit(1)
  }

  global.bot.commands = {}
  global.bot.ignoredChannels = []
  global.bot.guildSettingsCache = {}

  indexCommands() // yes, block the thread while we read commands.
  await cacheGuildInfo()

  addBotListeners()

  global.bot.connect()
}

process.on('exit', (code) => {
  global.logger.error(`The process is exiting with code ${code}. Terminating pgsql connections...`)
  const poolClient = require('../db/clients/postgres')
  poolClient.end(() => {
    global.logger.info('PostgreSQL clients returned')
  })
  if (process.env.TWILIGHT_PROXY_PORT) {
    global.bot.requestHandler.closeConn()
  }
})

process.on('SIGINT', async () => {
  global.logger.error('SIGINT caught. Cleaning up and exiting...')
  require('../db/clients/postgres').end()
  process.exit()
})

process.on('unhandledRejection', (e) => {
  if (!e.message.includes('[50013]') && !e.message.includes('Request timed out') && !e.message.startsWith('500 INTERNAL SERVER ERROR') && !e.message.includes('503 Service Temporarily Unavailable') && !e.message.includes('global ratelimit') && !e.message.includes('hang up')) {
    global.logger.error_nosentry(e)
    // sentry catches these already, stop double reporting
    // Sentry.captureException(e.stack, { level: 'error' }) // handle when Discord freaks out
  }
})

process.on('uncaughtException', (e) => {
  if (!e.message.includes('[50013]') && !e.message.includes('Request timed out') && !e.message.startsWith('500 INTERNAL SERVER ERROR') && !e.message.includes('503 Service Temporarily Unavailable') && !e.message.includes('global ratelimit') && !e.message.includes('hang up')) {
    global.logger.error_nosentry(e)
    Sentry.captureException(e.stack, { level: 'fatal' })
  }
})

init()
