const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const pool = require('../../src/db/clients/postgres')
const store = require('../../src/db/interfaces/postgres/youtube')

// Records SQL instead of talking to Postgres. `currentRef` is what the channel row holds.
let queries
let transaction
let currentRef
beforeEach((t) => {
  queries = []
  transaction = []
  currentRef = null
  t.mock.method(pool, 'query', async (sql, args) => {
    const flat = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: flat, args })
    if (flat.startsWith('SELECT channel_ref')) return { rows: currentRef ? [{ channel_ref: currentRef }] : [] }
    if (flat.startsWith('SELECT * FROM youtube_channels')) return { rows: [{ guild_id: '1', channel_ref: '@x' }] }
    if (flat.startsWith('SELECT video_id')) return { rows: [{ video_id: 'v1' }, { video_id: 'v2' }] }
    if (flat.startsWith('SELECT summary')) return { rows: args[1] === 'v1' ? [{ summary: '要約' }] : [] }
    return { rows: [{ video_id: 'v1', summary: null }] }
  })
  t.mock.method(pool, 'getPostgresClient', async () => ({
    query: async (sql, args) => {
      transaction.push(sql.replace(/\s+/g, ' ').trim())
      if (args?.[1] === 'boom') throw new Error('insert failed')
    },
    release: () => transaction.push('release')
  }))
})

const verbs = list => list.map(sql => sql.split(' ').slice(0, 3).join(' '))

describe('youtube store', () => {
  // Must stay the first test in this file: it is the first use of the store in this process.
  test('creates its tables once, on first use', async () => {
    const creates = () => queries.filter(q => q.sql.startsWith('CREATE TABLE IF NOT EXISTS')).map(q => q.sql.split(' ')[5])
    await store.getKnowledge('1')
    assert.deepEqual(creates(), ['youtube_channels', 'youtube_videos', 'youtube_summaries'])
    await store.getKnowledge('1')
    await store.getVideoIds('1')
    assert.equal(creates().length, 3)
  })

  test('setting a different channel starts over', async () => {
    currentRef = '@old'
    await store.setChannelRef('1', '@new')
    assert.match(queries[1].sql, /^INSERT INTO youtube_channels .* ON CONFLICT \(guild_id\) DO UPDATE SET channel_ref = \$2, channel_id = NULL/)
    assert.deepEqual(queries[2], { sql: 'DELETE FROM youtube_videos WHERE guild_id = $1', args: ['1'] })
  })

  test('setting the same channel again keeps what was accumulated', async () => {
    currentRef = '@same'
    await store.setChannelRef('1', '@same')
    assert.deepEqual(queries.map(q => q.sql), ['SELECT channel_ref FROM youtube_channels WHERE guild_id = $1'])
  })

  test('a sync adds and refreshes videos in one transaction, never deleting any', async () => {
    await store.saveSync('1', { channel: { id: 'UC', title: 't' }, videos: [{ id: 'v1' }, { id: 'v2' }] })
    assert.deepEqual(verbs(transaction), ['BEGIN', 'UPDATE youtube_channels SET', 'INSERT INTO youtube_videos', 'INSERT INTO youtube_videos', 'COMMIT', 'release'])
    assert.match(transaction[2], /ON CONFLICT \(guild_id, video_id\) DO UPDATE SET title = \$3/)
    assert.ok(!transaction.some(sql => sql.startsWith('DELETE')))
  })

  test('a failed sync rolls back and still releases the client', async () => {
    await assert.rejects(store.saveSync('1', { channel: { id: 'UC' }, videos: [{ id: 'boom' }] }), /insert failed/)
    assert.deepEqual(transaction.slice(-2), ['ROLLBACK', 'release'])
  })

  test('getVideoIds returns the stored IDs as a set', async () => {
    assert.deepEqual([...await store.getVideoIds('1')], ['v1', 'v2'])
  })

  test('getKnowledge returns videos newest first, joined with their summaries', async () => {
    const knowledge = await store.getKnowledge('1')
    assert.deepEqual(knowledge, { channel: { guild_id: '1', channel_ref: '@x' }, videos: [{ video_id: 'v1', summary: null }] })
    assert.match(queries.at(-1).sql, /LEFT JOIN youtube_summaries s ON .* ORDER BY v\.published_at DESC NULLS LAST$/)
  })

  test('summaries are read, written (replacing an older one) and listed when outside the channel', async () => {
    assert.equal(await store.getSummary('1', 'v1'), '要約')
    assert.equal(await store.getSummary('1', 'v9'), null)
    await store.saveSummary('1', 'v9', '新しい要約')
    assert.match(queries.at(-1).sql, /^INSERT INTO youtube_summaries .* ON CONFLICT \(guild_id, video_id\) DO UPDATE SET summary = \$3/)
    assert.deepEqual(queries.at(-1).args, ['1', 'v9', '新しい要約'])
    await store.getOtherSummaries('1')
    assert.match(queries.at(-1).sql, /NOT EXISTS \(SELECT 1 FROM youtube_videos v WHERE v\.guild_id = s\.guild_id AND v\.video_id = s\.video_id\)/)
  })

  test('leaving a server deletes all of its YouTube data', async () => {
    await store.deleteGuildYouTube('1')
    assert.deepEqual(queries.map(q => q.sql), [
      'DELETE FROM youtube_summaries WHERE guild_id = $1',
      'DELETE FROM youtube_videos WHERE guild_id = $1',
      'DELETE FROM youtube_channels WHERE guild_id = $1'
    ])
  })
})
