// The streamer's Discord messages as knowledge: discord_pages / discord_sections / discord_facts
// (migrations/016_discord_knowledge.sql), one page per server, account and month, written by
// discordKnowledge.js in the bot. The same shape as the wiki's tables.
module.exports = require('./wiki').createStore('discord')
