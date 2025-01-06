module.exports = async (guildID) => {
	const getGuildDocument = require('../../db/interfaces/postgres/read').getGuild;
	const GuildSettings = require('../bases/GuildSettings');
	const doc = await getGuildDocument(guildID);
	global.bot.guildSettingsCache[guildID] = new GuildSettings(doc);
};
