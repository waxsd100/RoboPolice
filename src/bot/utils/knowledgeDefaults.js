// What the knowledge features read when their setting is not set: this bot is made for the
// のばまんゲームス community. Set a variable to change it, or to an empty string to turn that
// feature off.
const DEFAULTS = {
  // wikiKnowledge.js
  WIKI_URLS: 'https://novamanhikoushiki.memo.wiki/',
  // twitterKnowledge.js
  TWITTER_ACCOUNTS: 'nobamangames',
  // discordKnowledge.js: のばまん's own account
  DISCORD_KNOWLEDGE_USERS: '615170548187791365',
  // webKnowledge.js
  KNOWLEDGE_TOPICS: [
    'ぽみそしる（ポッキーが主催し、のばまんが所属する実況者グループ）',
    'トマスコ（トマトスコスコ人生。きりやん・ぐちつぼ・のばまん・やみえんのユニット）'
  ].join(',')
}

// The variable's value, or its default when it is not set at all.
function knowledgeSetting (name) {
  return process.env[name] ?? DEFAULTS[name] ?? ''
}

module.exports = { knowledgeSetting, DEFAULTS }
