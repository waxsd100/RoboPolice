// The migrations on a database in the shape it had before them, with data in every old table.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const database = require('./database')
require('../helpers/fakes')

describe('migrations', { skip: !database.available && 'needs PGHOST' }, () => {
  let pool, aes, migrate
  const q = async (sql, args) => (await pool.query(sql, args)).rows

  before(async () => {
    await database.create()
    pool = require('../../src/db/clients/postgres')
    aes = require('../../src/db/aes')
    migrate = require('../../src/db/migrate').migrate
    // Only the baseline: the schema as deployments had it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'))
    fs.copyFileSync(path.join(__dirname, '../../src/db/migrations/001_baseline.sql'), path.join(dir, '001_baseline.sql'))
    await migrate({ dir })

    await q(`INSERT INTO guilds (id, owner_id, ignored_channels, disabled_events, event_logs, log_bots, custom_settings) VALUES
      ('g1', 'o1', '{c9,c8}', '{presenceUpdate}', '{"messageDelete": "c1", "messageUpdate": "c1", "channelCreate": ""}', true, '{}'),
      ('g2', 'o2', NULL, NULL, NULL, NULL, NULL)`)
    const piece = url => aes.encrypt(Buffer.from(url).toString('base64url'))
    await q(`INSERT INTO messages (id, author_id, content, attachment_b64, ts, channel_id, guild_id, embedded) VALUES
      ('m1', 'u1', $1, $2, '2026-10-01', 'c1', 'g1', true),
      ('m2', 'u1', $1, '', '2026-10-02', 'c1', 'g1', false)`,
    [aes.encrypt('hi'), [piece('https://cdn/a.png'), piece('https://cdn/b.png')].join('|')])
    await q("INSERT INTO message_embeddings (message_id, guild_id, channel_id, ts, embedding, model) VALUES ('m1', 'g1', 'c1', '2026-10-01', 'vec', 'model-a')")
    // Two servers with the same channel, so every video is stored twice; one legacy row without an ID.
    await q(`INSERT INTO youtube_channels (guild_id, channel_ref, channel_id, title, synced_at, backfill_token, live_events) VALUES
      ('g1', '@chan', 'UC1', 'チャンネル', '2026-10-01', NULL, true),
      ('g2', 'https://youtube.com/@chan', 'UC1', 'チャンネル（古い）', '2026-09-01', 'tok', false),
      ('g3', '@legacy', NULL, NULL, NULL, NULL, false)`)
    for (const guild of ['g1', 'g2']) {
      await q(`INSERT INTO youtube_videos (guild_id, video_id, title, published_at, live_status, url, embedding, embedding_hash, embedding_model) VALUES
        ($1, 'v1', '動画1', '2026-09-01', 'none', 'https://www.youtube.com/watch?v=v1', 'e1', 'h1', 'model-a'),
        ($1, 'v2', '配信', '2026-09-02', 'upcoming', 'https://www.youtube.com/watch?v=v2', NULL, NULL, NULL)`, [guild])
    }
    await q(`INSERT INTO youtube_summaries (guild_id, video_id, summary, created_at) VALUES
      ('g1', 'v1', '古い要約', '2026-09-01'), ('g2', 'v1', '新しい要約', '2026-09-05'), ('g1', 'x9', '他チャンネルの要約', '2026-09-03')`)
    await q(`INSERT INTO youtube_live_events (guild_id, video_id, event_id, status) VALUES
      ('g1', 'v2', 'ev1', 'scheduled'), ('g1', 'gone-video', 'ev2', 'completed')`)
    await q("INSERT INTO youtube_websub (channel_id, expires_at) VALUES ('UC1', '2026-11-01')")

    await migrate()
  })
  after(() => database.drop())

  test('records every migration, and a second run does nothing', async () => {
    const versions = (await q('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version)
    assert.deepEqual(versions, require('../../src/db/migrate').migrationFiles().map(m => m.version))
    assert.deepEqual(await migrate(), [])
  })

  test('server settings become rows', async () => {
    assert.deepEqual(await q('SELECT guild_id, event, channel_id FROM guild_event_logs ORDER BY event'), [
      { guild_id: 'g1', event: 'messageDelete', channel_id: 'c1' },
      { guild_id: 'g1', event: 'messageUpdate', channel_id: 'c1' }
    ])
    assert.deepEqual(await q('SELECT guild_id, channel_id FROM guild_ignored_channels ORDER BY channel_id'), [
      { guild_id: 'g1', channel_id: 'c8' }, { guild_id: 'g1', channel_id: 'c9' }
    ])
    assert.deepEqual(await q('SELECT guild_id, event FROM guild_disabled_events'), [{ guild_id: 'g1', event: 'presenceUpdate' }])
    assert.deepEqual(await q('SELECT id, log_bots FROM guilds ORDER BY id'), [{ id: 'g1', log_bots: true }, { id: 'g2', log_bots: false }])
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'guilds' ORDER BY column_name")).map(r => r.column_name)
    assert.deepEqual(columns, ['id', 'log_bots', 'owner_id'])
  })

  test('image URLs become rows, encrypted as they are', async () => {
    const rows = await q('SELECT message_id, position, url FROM message_attachments ORDER BY position')
    assert.deepEqual(rows.map(r => [r.message_id, r.position, aes.decrypt(r.url)]), [['m1', 0, 'https://cdn/a.png'], ['m1', 1, 'https://cdn/b.png']])
    const read = require('../../src/db/interfaces/postgres/read')
    assert.deepEqual((await read.getMessageById('m1')).attachment_urls, ['https://cdn/a.png', 'https://cdn/b.png'])
    assert.deepEqual((await read.getMessageById('m2')).attachment_urls, [])
  })

  test('message embeddings keep only what is not on the message', async () => {
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'message_embeddings' ORDER BY column_name")).map(r => r.column_name)
    assert.deepEqual(columns, ['embedding', 'message_id', 'model'])
    assert.deepEqual(await q('SELECT message_id, model FROM message_embeddings'), [{ message_id: 'm1', model: 'model-a' }])
  })

  test('channels and videos are stored once, servers point at them', async () => {
    assert.deepEqual(await q('SELECT channel_id, title, backfill_token, websub_expires_at IS NOT NULL AS websub FROM youtube_channels'), [
      { channel_id: 'UC1', title: 'チャンネル', backfill_token: null, websub: true }
    ])
    assert.deepEqual(await q('SELECT guild_id, channel_ref, channel_id, live_events FROM guild_youtube ORDER BY guild_id'), [
      { guild_id: 'g1', channel_ref: '@chan', channel_id: 'UC1', live_events: true },
      { guild_id: 'g2', channel_ref: 'https://youtube.com/@chan', channel_id: 'UC1', live_events: false },
      { guild_id: 'g3', channel_ref: '@legacy', channel_id: null, live_events: false }
    ])
    assert.deepEqual(await q('SELECT video_id, channel_id FROM youtube_videos ORDER BY video_id'), [
      { video_id: 'v1', channel_id: 'UC1' }, { video_id: 'v2', channel_id: 'UC1' }
    ])
    assert.deepEqual(await q('SELECT video_id, text_hash, model FROM youtube_video_embeddings'), [{ video_id: 'v1', text_hash: 'h1', model: 'model-a' }])
  })

  test('summaries are kept once (the newest), and who asked is kept per server', async () => {
    assert.deepEqual(await q('SELECT video_id, summary FROM youtube_summaries ORDER BY video_id'), [
      { video_id: 'v1', summary: '新しい要約' }, { video_id: 'x9', summary: '他チャンネルの要約' }
    ])
    assert.deepEqual(await q('SELECT guild_id, video_id FROM guild_youtube_summaries ORDER BY guild_id, video_id'), [
      { guild_id: 'g1', video_id: 'v1' }, { guild_id: 'g1', video_id: 'x9' }, { guild_id: 'g2', video_id: 'v1' }
    ])
  })

  test('stream events whose video is gone are dropped', async () => {
    assert.deepEqual(await q('SELECT guild_id, video_id, event_id FROM youtube_live_events'), [{ guild_id: 'g1', video_id: 'v2', event_id: 'ev1' }])
    const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map(r => r.tablename)
    assert.ok(!tables.includes('youtube_websub') && !tables.some(t => t.startsWith('old_')))
  })
})
