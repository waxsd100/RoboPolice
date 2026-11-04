// The streamer's Discord messages as knowledge: the knowledge tables as source 'discord'
// (migrations/030_normalize.sql), one page per server, account and month, written by
// discordKnowledge.js in the bot.
module.exports = require('./wiki').createStore('discord')
