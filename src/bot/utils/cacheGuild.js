module.exports = async guildID => {
  const getGuildDocument = require('../../db/interfaces/postgres/read').getGuild
  const GuildSettings = require('../bases/GuildSettings') // GuildSettings will NOT resolve if you require it outside of this function(?)
  const doc = await getGuildDocument(guildID)
  if (!doc) return null
  global.bot.guildSettingsCache[guildID] = new GuildSettings(doc)
  return global.bot.guildSettingsCache[guildID]
}
