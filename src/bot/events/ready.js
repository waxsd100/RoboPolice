const cluster = require('cluster')
const checkForMissingSettings = require('../utils/recoverSettings')
const prune = require('../../miscellaneous/prune')
const youtubeSync = require('../modules/youtubeSync')
const embeddingIndexer = require('../modules/embeddingIndexer')
const liveWatcher = require('../modules/liveWatcher')
const { saveGuildDetails } = require('../../db/interfaces/postgres/update')

let failedHealthCheckCount = 0

module.exports = {
  name: 'ready',
  type: 'once',
  handle: async () => {
    global.logger.info(`Worker instance hosting ${cluster.worker.rangeForShard} on id ${cluster.worker.id} is now ready to serve requests. This shard or shard range has ${global.bot.guilds.size} guilds and ${global.bot.users.size} users cached.`)
    global.webhook.generic(`Worker instance hosting ${cluster.worker.rangeForShard} on id ${cluster.worker.id} is now ready to serve requests. This shard or shard range has ${global.bot.guilds.size} guilds and ${global.bot.users.size} users cached.`)

    if (global.bot.shards.find(s => s.id === 0)) { // only check for missing settings once
      await checkForMissingSettings()
      prune.startScheduler() // one worker owns the sweep so shards don't duplicate the delete
      embeddingIndexer.startIndexer() // the same worker embeds videos and messages for every server
      require('../modules/wikiKnowledge').startWiki() // ...and reads the community wiki (WIKI_URLS)
      require('../modules/twitterKnowledge').startTwitter() // ...and the streamer's X posts (TWITTER_ACCOUNTS)
      // ...and, once, finds the channel of messages stored before channels were recorded.
      require('../../miscellaneous/backfillChannels').startBackfill()
    }
    // Every worker keeps the details of the servers it hosts current (member counts change hourly enough).
    const saveDetails = () => Promise.all([...global.bot.guilds.values()].map(g => saveGuildDetails(g)))
      .catch(e => global.logger.warn(`Could not save server details: ${e.message}`))
    saveDetails()
    setInterval(saveDetails, 60 * 60 * 1000)
    // ...and describes their emojis, in the background.
    require('../modules/emojiDescriber').startDescriber()
    // The worker hosting the owner's servers reads the streamer's past messages there.
    require('../modules/discordKnowledge').startDiscordKnowledge()
    // Every worker checks the servers it hosts for new YouTube videos.
    youtubeSync.startAutoSync()
    // ...and follows their streams, for those that turned stream events on.
    liveWatcher.startWatcher()
    setInterval(() => {
      if (bot.shards.filter(shard => shard.latency == Infinity && shard.status === 'disconnected').length !== 0) {
        failedHealthCheckCount++
        global.logger.warn(`[${cluster.worker.rangeForShard}] Found disconnected shards ${bot.shards.filter(shard => shard.latency == Infinity && shard.status === 'disconnected').map(s => s.id).join(', ')}, failure count is ${failedHealthCheckCount}`)
        if (failedHealthCheckCount >= 5) {
          global.logger.warn(`[${cluster.worker.rangeForShard}] Shard health check failed 5 times in a row, hard resetting shards`)
          global.webhook.error(`[${cluster.worker.rangeForShard}] Shard health check failed 5 times in a row, hard resetting shards`)
          failedHealthCheckCount = 0
          bot.shards.forEach(shard => {
            shard.hardReset()
            shard.connect()
          })
        }
      } else if (failedHealthCheckCount > 0) {
        failedHealthCheckCount--
      }
    }, 1000 * 60)
  }
}

