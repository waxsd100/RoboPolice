const getAllDBGuilds = require('../../db/interfaces/postgres/read').getAllGuilds
const createGuild = require('../../db/interfaces/postgres/create').createGuild

module.exports = async () => { // If the bot sees a guild that the DB or worker cache doesn't know, recover it
  const allGuilds = await getAllDBGuilds()
  const knownIds = new Set(allGuilds.map(g => g.id))
  const guilds = global.bot.guilds instanceof Map ? [...global.bot.guilds.values()] : Object.values(global.bot.guilds || {})
  const missing = guilds.filter(guild => !knownIds.has(guild.id) || !global.bot.guildSettingsCache?.[guild.id])
  if (missing.length > 0) {
    await Promise.all(missing.map(guild => createGuild(guild)))
    global.logger.info(`Recovered ${missing.length} missing guild document(s).`)
  } else {
    global.logger.info('Found no missing guild documents.')
  }
}
