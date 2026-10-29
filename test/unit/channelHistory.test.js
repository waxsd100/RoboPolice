const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createGuild, createMember, installBot } = require('../helpers/fakes')
const pool = require('../../src/db/clients/postgres')
const aes = require('../../src/db/aes')
const batcher = require('../../src/db/messageBatcher')
const read = require('../../src/db/interfaces/postgres/read')
const { createTools } = require('../../src/bot/modules/eventTools')

global.webhook = global.webhook || { generic () {}, warn () {}, error () {} }

let queries
let inserted
beforeEach((t) => {
  queries = []
  inserted = []
  t.mock.method(pool, 'query', async (sql, args) => {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
    if (/FROM messages WHERE channel_id/.test(sql)) {
      return { rows: [{ id: 'db2', author_id: '2', content: aes.encrypt('DBの新しい方'), ts: new Date('2026-10-28T00:00:00Z') }, { id: 'db1', author_id: '3', content: aes.encrypt('DBの古い方'), ts: new Date('2026-10-20T00:00:00Z') }].slice(0, args[1]) }
    }
    return { rows: [] }
  })
  t.mock.method(pool, 'getPostgresClient', async () => ({
    query: async sql => inserted.push(sql),
    release () {}
  }))
})

describe('stored messages carry their channel and server', () => {
  // First test in this file on purpose: it is the first use of the columns in this process.
  test('the columns and index are added once, before the first write', async () => {
    const row = (id) => [id, '1', aes.encrypt('hi'), '', '2026-10-29T00:00:00.000Z', '201', '100']
    for (let i = 0; i < 10; i++) await batcher.addItem(row(`m${i}`))
    for (let i = 10; i < 20; i++) await batcher.addItem(row(`m${i}`))
    assert.deepEqual(queries.map(q => q.sql), [
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id TEXT',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS guild_id TEXT',
      'CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages (channel_id, ts DESC)'
    ])
    assert.equal(inserted.length, 2)
    assert.match(inserted[0], /^INSERT INTO messages \(id, author_id, content, attachment_b64, ts, channel_id, guild_id\) VALUES \('m0', '1', '[^']+', '', '2026-10-29T00:00:00.000Z', '201', '100'\)/)
  })

  test('cacheMessage records the channel and server', async (t) => {
    const added = t.mock.method(batcher, 'addItem', async () => {})
    await require('../../src/db/interfaces/postgres/create').cacheMessage({
      id: 'm', content: 'hello', attachments: [], author: { id: '1' }, channel: { id: '201', guild: { id: '100' } }
    })
    const row = added.mock.calls[0].arguments[0]
    assert.deepEqual(row.slice(5), ['201', '100'])
    assert.equal(aes.decrypt(row[2]), 'hello')
  })
})

describe('getChannelHistory', () => {
  test('returns messages still in memory first, then Postgres, decrypted and capped', async () => {
    await batcher.addItem(['pending1', '4', aes.encrypt('まだメモリ'), '', '2026-10-29T01:00:00.000Z', '301', '100'])
    await batcher.addItem(['other', '4', aes.encrypt('別チャンネル'), '', '2026-10-29T01:00:00.000Z', '999', '100'])
    const rows = await read.getChannelHistory('301', 2)
    assert.deepEqual(rows.map(r => [r.id, r.content]), [['pending1', 'まだメモリ'], ['db2', 'DBの新しい方']])
    const select = queries.find(q => q.sql.startsWith('SELECT'))
    assert.equal(select.sql, 'SELECT id, author_id, content, ts FROM messages WHERE channel_id = $1 ORDER BY ts DESC LIMIT $2')
    assert.deepEqual(select.args, ['301', 1])
  })
})

describe('search_channel_history', () => {
  const REQUESTER = '1'
  const guild = createGuild({
    channels: [
      { id: '201', name: 'general', type: 0, readers: [REQUESTER, 'BOT'] },
      { id: '202', name: 'staff', type: 0, readers: ['BOT'] }
    ]
  })
  guild.members.set('2', { id: '2', username: 'alice' })
  const member = createMember({ id: REQUESTER })
  const history = [
    { author_id: '2', content: '11/3 の交流会、19時からでどう？', ts: new Date('2026-10-28T10:00:00Z') },
    { author_id: '3', content: '賛成！場所は  ボイスで', ts: new Date('2026-10-27T10:00:00Z') },
    { author_id: '2', content: 'マイクラの話', ts: new Date('2026-10-20T10:00:00Z') }
  ]

  function tools () {
    installBot({ guilds: [guild] })
    return createTools({ guild, member, ask: async () => '' })
  }

  test('reads the stored history oldest first, with member names, and records the source', async (t) => {
    const asked = t.mock.method(read, 'getChannelHistory', async () => history)
    const tl = tools()
    const res = await tl.call('search_channel_history', { channel_id: '201' })
    assert.deepEqual(asked.mock.calls[0].arguments, ['201', 1000])
    assert.equal(res.result, [
      '<#201> の保存済みメッセージ 3 件（2026-10-20T10:00:00.000Z 以降）、古い順:',
      '[2026-10-20T10:00:00.000Z] alice: マイクラの話',
      '[2026-10-27T10:00:00.000Z] 3: 賛成！場所は ボイスで',
      '[2026-10-28T10:00:00.000Z] alice: 11/3 の交流会、19時からでどう？'
    ].join('\n'))
    assert.deepEqual(tl.sources, ['<#201>'])
  })

  test('narrows to messages containing every query word', async (t) => {
    t.mock.method(read, 'getChannelHistory', async () => history)
    const res = await tools().call('search_channel_history', { channel_id: '201', query: '交流会 19時' })
    assert.match(res.result, /のうち「交流会 19時」を含む 1 件、古い順:\n\[2026-10-28T10:00:00\.000Z\] alice: 11\/3 の交流会/)
  })

  test('refuses a channel the requester cannot read, without touching the database', async (t) => {
    const asked = t.mock.method(read, 'getChannelHistory', async () => history)
    const res = await tools().call('search_channel_history', { channel_id: '202' })
    assert.match(res.error, /依頼者がこのチャンネルのメッセージを閲覧できません/)
    assert.equal(asked.mock.callCount(), 0)
  })

  test('explains when nothing is stored', async (t) => {
    t.mock.method(read, 'getChannelHistory', async () => [])
    assert.match((await tools().call('search_channel_history', { channel_id: '201' })).result, /保存済みメッセージはありません（保存しているのは削除・編集ログを設定したサーバーの、保持期間内のメッセージのみ）/)
  })

  test('caps the result and says how many more there are', async (t) => {
    const many = Array.from({ length: 150 }, (_, i) => ({ author_id: '2', content: `msg ${i}`, ts: new Date(Date.UTC(2026, 9, 1, 0, 0, 150 - i)) }))
    t.mock.method(read, 'getChannelHistory', async () => many)
    const text = (await tools().call('search_channel_history', { channel_id: '201' })).result
    assert.equal(text.split('\n').length, 1 + 100 + 1)
    assert.match(text, /…ほか 50 件（query で絞り込めます）$/)
    // The newest 100 are kept, shown oldest first.
    assert.match(text.split('\n')[1], /msg 99$/)
  })
})
