const createGuild = require('../../db/interfaces/postgres/create').createGuild
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'guildCreate',
  type: 'on',
  handle: async guild => {
    await createGuild(guild) // Create guild document in database
    await cacheGuild(guild.id) // Create a guildsettings object and cache it
    // Logging starts at once: every event to a staff-only channel (autoLogChannel.js).
    await require('../modules/autoLogChannel').startLogging(guild)
      .catch(e => global.logger.warn(`[AUTO LOG]: Could not start logging in ${guild.id}: ${e.message}`))
    require('../modules/emojiDescriber').schedule(guild) // describe its emojis in the background
  }
}
