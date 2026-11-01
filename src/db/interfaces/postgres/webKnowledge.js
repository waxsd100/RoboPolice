// Knowledge looked up on the web: web_pages / web_sections / web_facts
// (migrations/018_web_knowledge.sql), one page per topic, written by webKnowledge.js in the bot.
// The same shape as the wiki's tables.
module.exports = require('./wiki').createStore('web')
