const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const pool = require('../../src/db/clients/postgres')
const store = require('../../src/db/interfaces/postgres/youtube')

// Records SQL instead of talking to Postgres.
let queries
let transaction
beforeEach((t) => {
  queries = []
  transaction = []
  t.mock.method(pool, 'query', async (sql, args) => {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
    if (/SELECT \* FROM youtube_channels/.test(sql)) return { rows: [{ guild_id: '1', channel_ref: '@x' }] }
    return { rows: [{ video_id: 'v1' }] }
  })
  t.mock.method(pool, 'getPostgresClient', async () => ({
    query: async (sql, args) => {
      transaction.push(sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' '))
      if (args?.[1] === 'boom') throw new Error('insert failed')
    },
    release: () => transaction.push('release')
  }))
})

describe('youtube store', () => {
  // Must stay the first test in this file: it is the first use of the store in this process.
  test('creates its tables once, on first use', async () => {
    const creates = () => queries.filter(q => q.sql.startsWith('CREATE TABLE IF NOT EXISTS')).map(q => q.sql.split(' ')[5])
    await store.getKnowledge('1')
    assert.deepEqual(creates(), ['youtube_channels', 'youtube_videos'])
    await store.getKnowledge('1')
    await store.setChannelRef('1', '@x')
    assert.deepEqual(creates(), ['youtube_channels', 'youtube_videos'])
  })

  test('setting a channel clears what was stored for the old one', async () => {
    await store.setChannelRef('1', '@new')
    assert.match(queries[0].sql, /^INSERT INTO youtube_channels .* ON CONFLICT \(guild_id\) DO UPDATE SET channel_ref = \$2, channel_id = NULL/)
    assert.deepEqual(queries[0].args, ['1', '@new'])
    assert.deepEqual(queries[1], { sql: 'DELETE FROM youtube_videos WHERE guild_id = $1', args: ['1'] })
  })

  test('a sync replaces the videos in one transaction', async () => {
    await store.saveSync('1', { channel: { id: 'UC', title: 't' }, videos: [{ id: 'v1' }, { id: 'v2' }] })
    assert.deepEqual(transaction, ['BEGIN', 'UPDATE youtube_channels SET', 'DELETE FROM youtube_videos', 'INSERT INTO youtube_videos', 'INSERT INTO youtube_videos', 'COMMIT', 'release'])
  })

  test('a failed sync rolls back and still releases the client', async () => {
    await assert.rejects(store.saveSync('1', { channel: { id: 'UC' }, videos: [{ id: 'boom' }] }), /insert failed/)
    assert.deepEqual(transaction.slice(-2), ['ROLLBACK', 'release'])
  })

  test('getKnowledge returns the channel and its videos, newest first', async () => {
    const knowledge = await store.getKnowledge('1')
    assert.deepEqual(knowledge, { channel: { guild_id: '1', channel_ref: '@x' }, videos: [{ video_id: 'v1' }] })
    assert.match(queries.at(-1).sql, /ORDER BY published_at DESC NULLS LAST$/)
  })

  test('leaving a server deletes its YouTube data', async () => {
    await store.deleteGuildYouTube('1')
    assert.deepEqual(queries.map(q => q.sql), ['DELETE FROM youtube_videos WHERE guild_id = $1', 'DELETE FROM youtube_channels WHERE guild_id = $1'])
  })
})
