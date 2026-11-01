// What the knowledge features read when their setting is not set: this bot is made for the
// のばまんゲームス community. Set a variable to change it, or to an empty string to turn that
// feature off.
const DEFAULTS = {
  // wikiKnowledge.js
  WIKI_URLS: 'https://novamanhikoushiki.memo.wiki/',
  // twitterKnowledge.js
  TWITTER_ACCOUNTS: 'nobamangames',
  // youtubeSync.js: the channels the bot follows, for every server (のばまんゲームス)
  YOUTUBE_CHANNELS: 'UCTW2tw0Mhho72MojB1L48IQ',
  // discordKnowledge.js: のばまん's own account
  DISCORD_KNOWLEDGE_USERS: '615170548187791365',
  // webKnowledge.js
  KNOWLEDGE_TOPICS: [
    // The members as found when this was written (2026-11): looked up again every week, so changes
    // since are found too.
    'ぽみそしる（ポッキーが主催し、のばまんが所属する実況者グループ。2022年7月結成。' +
      '結成時のメンバーはポッキー・赤髪のとも・カンタ（水溜りボンド）・まひとくん。・のばまん・ちはやYT・ふうはや・ネフライト・おらふくん・あきピヨの10人。' +
      'のちに赤髪のとも・おらふくん・カンタ・ちはやYT・まひとくん。が卒業。今のメンバーと、それぞれの卒業の時期も調べる）',
    'トマスコ（トマトスコスコ人生。きりやん・ぐちつぼ・のばまん・やみえんのユニット）'
  ].join(',')
}

// The variable's value, or its default when it is not set at all.
function knowledgeSetting (name) {
  return process.env[name] ?? DEFAULTS[name] ?? ''
}

module.exports = { knowledgeSetting, DEFAULTS }
