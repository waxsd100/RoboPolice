const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installEmbeddingModel } = require('../helpers/fakes')
const { relatedRecent } = require('../../src/bot/modules/recentTopics')

const NOW = Date.parse('2026-11-04T12:00:00Z') // 21:00 in Japan
const MIN = 60 * 1000
const guild = { members: new Map([['10', { nick: 'くらじー' }]]) }
const mention = { id: '900', channel: { id: 'c1', guild } }
const msg = (id, minutesAgo, content, author = { id: '10', username: 'kuraji' }) => ({ id, timestamp: NOW - minutesAgo * MIN, content, author })

afterEach(() => {
  for (const name of ['MENTION_RECENT_TOPICS', 'MENTION_RECENT_HOURS', 'MENTION_RECENT_MESSAGES']) delete process.env[name]
})

test('the recent messages close to the request, oldest first, with who said them', async () => {
  configureGateway()
  const batches = installEmbeddingModel()
  const asked = []
  const getMessages = async (id, o) => {
    asked.push({ id, ...o })
    return [
      msg('6', 1, 'マイクラの建築どうする？'),
      msg('5', 2, '今日の晩ごはん何にしよ'),
      msg('4', 3, 'マイクラで城つくりたい', { id: 'BOT', username: 'bot', bot: true }),
      msg('3', 4, 'w'),
      msg('2', 5, '!rank'),
      null,
      msg('1', 20 * 60, 'マイクラ昔やってた')
    ]
  }
  const lines = await relatedRecent(mention, 'さっきのマイクラの話だけどどう思う？', { now: NOW, getMessages })
  assert.deepEqual(asked, [{ id: 'c1', limit: 50, before: '900' }])
  assert.deepEqual(lines, ['- [20:59] くらじー（<@10>）: マイクラの建築どうする？'])
  // The request as a query, the candidates as documents: no bot, command, noise or old message among them.
  assert.deepEqual(batches.map(b => b.requests.map(r => r.content.parts[0].text)), [['さっきのマイクラの話だけどどう思う？'], ['マイクラの建築どうする？', '今日の晩ごはん何にしよ']])
})

test('nothing when nothing is close, the request says nothing, or it is turned off', async () => {
  configureGateway()
  installEmbeddingModel()
  const getMessages = async () => [msg('1', 1, '今日の晩ごはん何にしよ')]
  assert.deepEqual(await relatedRecent(mention, 'ホラーゲームのおすすめある？', { now: NOW, getMessages }), [])
  assert.deepEqual(await relatedRecent(mention, 'w', { now: NOW, getMessages: async () => { throw new Error('not read') } }), [])
  process.env.MENTION_RECENT_TOPICS = 'false'
  assert.deepEqual(await relatedRecent(mention, 'ホラーゲームのおすすめある？', { now: NOW, getMessages: async () => { throw new Error('not read') } }), [])
})
