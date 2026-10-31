// The X posts as knowledge: x_pages / x_sections / x_facts (migrations/015_x_knowledge.sql), one
// page per account and month, written by twitterKnowledge.js. The same shape as the wiki's tables.
module.exports = require('./wiki').createStore('x')
