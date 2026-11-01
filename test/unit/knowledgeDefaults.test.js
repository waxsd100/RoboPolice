// The knowledge features' defaults for the のばまんゲームス community.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { knowledgeSetting, DEFAULTS } = require('../../src/bot/utils/knowledgeDefaults')

test('a setting not set is its default; set, even to nothing, it is what was set', () => {
  const saved = process.env.TWITTER_ACCOUNTS
  try {
    delete process.env.TWITTER_ACCOUNTS
    assert.equal(knowledgeSetting('TWITTER_ACCOUNTS'), 'nobamangames')
    process.env.TWITTER_ACCOUNTS = ''
    assert.equal(knowledgeSetting('TWITTER_ACCOUNTS'), '', 'an empty value turns it off')
    process.env.TWITTER_ACCOUNTS = 'other'
    assert.equal(knowledgeSetting('TWITTER_ACCOUNTS'), 'other')
  } finally {
    if (saved === undefined) delete process.env.TWITTER_ACCOUNTS
    else process.env.TWITTER_ACCOUNTS = saved
  }
  assert.equal(DEFAULTS.WIKI_URLS, 'https://novamanhikoushiki.memo.wiki/')
  assert.equal(DEFAULTS.DISCORD_KNOWLEDGE_USERS, '615170548187791365')
  assert.match(DEFAULTS.KNOWLEDGE_TOPICS, /^ぽみそしる（.*）,トマスコ（.*）$/)
  assert.match(DEFAULTS.KNOWLEDGE_TOPICS, /ぽみそしる（[^）]*ポッキー・赤髪のとも・カンタ（水溜りボンド）・まひとくん。・のばまん・ちはやYT・ふうはや・ネフライト・おらふくん・あきピヨ/)
})
