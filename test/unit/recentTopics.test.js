const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installEmbeddingModel } = require('../helpers/fakes')
const { relatedRecent, clearCache } = require('../../src/bot/modules/recentTopics')

const NOW = Date.parse('2026-11-04T12:00:00Z') // 21:00 in Japan
const MIN = 60 * 1000
const guild = { members: new Map([['10', { nick: 'くらじー' }]]) }
const mention = { id: '900', channel: { id: 'c1', guild } }
const msg = (id, minutesAgo, content, author = { id: '10', username: 'kuraji' }) => ({ id, timestamp: NOW - minutesAgo * MIN, content, author })

afterEach(() => {
  clearCache()
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

test('reuses cached embeddings of recent messages across mentions, embedding only new messages', async () => {
  configureGateway()
  const batches = installEmbeddingModel()
  const history = [
    msg('6', 1, 'マイクラの建築どうする？'),
    msg('5', 2, '今日の晩ごはん何にしよ')
  ]
  const getMessages = async () => history
  await relatedRecent(mention, 'マイクラの話', { now: NOW, getMessages })
  assert.equal(batches.length, 2, 'first mention embeds query + 2 candidate messages')

  // Second mention with the same channel history: only the query is embedded.
  batches.length = 0
  const again = await relatedRecent(mention, 'マイクラの建築について', { now: NOW, getMessages })
  assert.deepEqual(again, ['- [20:59] くらじー（<@10>）: マイクラの建築どうする？'])
  assert.deepEqual(batches.map(b => b.requests.map(r => r.content.parts[0].text)), [['マイクラの建築について']], 'cached messages are not embedded again')

  // One new message arrives: only the query and the 1 new message are embedded.
  batches.length = 0
  history.unshift(msg('7', 0, 'ホラーゲームもやりたい'))
  const third = await relatedRecent(mention, '怖いゲームある？', { now: NOW, getMessages })
  assert.deepEqual(third, ['- [21:00] くらじー（<@10>）: ホラーゲームもやりたい'])
  assert.deepEqual(batches.map(b => b.requests.map(r => r.content.parts[0].text)), [['怖いゲームある？'], ['ホラーゲームもやりたい']])

  // Another worker or a restarted worker (memory cleared, Redis kept) reuses vectors from Redis.
  clearCache({ memoryOnly: true })
  batches.length = 0
  const fromRedis = await relatedRecent(mention, '怖いゲームある？', { now: NOW, getMessages })
  assert.deepEqual(fromRedis, ['- [21:00] くらじー（<@10>）: ホラーゲームもやりたい'])
  assert.deepEqual(batches.map(b => b.requests.map(r => r.content.parts[0].text)), [['怖いゲームある？']], 'loaded from Redis without re-embedding messages')
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
