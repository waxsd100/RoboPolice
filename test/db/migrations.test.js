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
  // An embedding as stored before pgvector: 512 signed bytes, base64.
  const legacyBytes = new Int8Array(512)
  legacyBytes[0] = 127
  const legacyVector = Buffer.from(legacyBytes.buffer).toString('base64')
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
      ('m2', 'u1', $1, '', '2026-10-02', 'c1', 'g1', true),
      ('m3', 'u1', $1, '', '2026-10-03', 'c7', 'left-server', false),
      ('m4', 'u1', $1, '', '2026-09-01', NULL, NULL, false)`,
    [aes.encrypt('hi'), [piece('https://cdn/a.png'), piece('https://cdn/b.png')].join('|')])
    await q("INSERT INTO message_embeddings (message_id, guild_id, channel_id, ts, embedding, model) VALUES ('m1', 'g1', 'c1', '2026-10-01', $1, 'model-a')", [aes.encrypt(legacyVector)])
    // Not 512 components: dropped, and the message embedded again.
    await q("INSERT INTO message_embeddings (message_id, guild_id, channel_id, ts, embedding, model) VALUES ('m2', 'g1', 'c1', '2026-10-02', $1, 'model-a')", [aes.encrypt('AAAA')])
    // Two servers with the same channel, so every video is stored twice; one legacy row without an ID.
    await q(`INSERT INTO youtube_channels (guild_id, channel_ref, channel_id, title, synced_at, backfill_token, live_events) VALUES
      ('g1', '@chan', 'UC1', 'チャンネル', '2026-10-01', NULL, true),
      ('g2', 'https://youtube.com/@chan', 'UC1', 'チャンネル（古い）', '2026-09-01', 'tok', false),
      ('g3', '@legacy', NULL, NULL, NULL, NULL, false)`)
    for (const guild of ['g1', 'g2']) {
      await q(`INSERT INTO youtube_videos (guild_id, video_id, title, published_at, live_status, url, embedding, embedding_hash, embedding_model) VALUES
        ($1, 'v1', '動画1', '2026-09-01', 'none', 'https://www.youtube.com/watch?v=v1', $2, 'h1', 'model-a'),
        ($1, 'v2', '配信', '2026-09-02', 'upcoming', 'https://www.youtube.com/watch?v=v2', NULL, NULL, NULL)`, [guild, legacyVector])
    }
    await q(`INSERT INTO youtube_summaries (guild_id, video_id, summary, created_at) VALUES
      ('g1', 'v1', '古い要約', '2026-09-01'), ('g2', 'v1', '新しい要約', '2026-09-05'), ('g1', 'x9', '他チャンネルの要約', '2026-09-03')`)
    await q(`INSERT INTO youtube_live_events (guild_id, video_id, event_id, status) VALUES
      ('g1', 'v2', 'ev1', 'scheduled'), ('g1', 'gone-video', 'ev2', 'completed')`)
    await q("INSERT INTO youtube_websub (channel_id, expires_at) VALUES ('UC1', '2026-11-01')")

    // Up to 014: X posts stored in the wiki's tables, as they were before 015.
    const upTo14 = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'))
    for (const m of require('../../src/db/migrate').migrationFiles().filter(m => m.version <= 14)) {
      // A .js migration requires files next to it: it is loaded from where it is.
      if (m.kind === 'js') fs.writeFileSync(path.join(upTo14, path.basename(m.file)), `module.exports = require(${JSON.stringify(m.file)})\n`)
      else fs.copyFileSync(m.file, path.join(upTo14, path.basename(m.file)))
    }
    await migrate({ dir: upTo14 })
    await q(`INSERT INTO wiki_pages (url, title) VALUES
      ('https://w.example/d/chars', 'キャラクター'), ('https://x.com/nobamangames#2026-10', '@nobamangames のポスト（2026年10月）')`)
    await q(`INSERT INTO wiki_sections (url, position, heading, text, text_hash, facts_hash) VALUES
      ('https://w.example/d/chars', 0, 'よつろん', '四葉', 'h1', 'h1'),
      ('https://x.com/nobamangames#2026-10', 0, '2026年10月 1', '告知', 'h2', 'h2')`)
    await q(`INSERT INTO wiki_facts (url, position, kind, name, content) VALUES
      ('https://w.example/d/chars', 0, 'character', 'よつろん', '四葉の笑顔'),
      ('https://x.com/nobamangames#2026-10', 0, 'term', '告知', 'お知らせ')`)
    await q("INSERT INTO social_posts (id, account, url, text, created_at) VALUES ('1', 'nobamangames', 'https://x.com/nobamangames/status/1', '告知', '2026-10-01')")

    await migrate()
  })
  after(() => database.drop())

  test('records every migration, and a second run does nothing', async () => {
    const versions = (await q('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version)
    assert.deepEqual(versions, require('../../src/db/migrate').migrationFiles().map(m => m.version))
    assert.deepEqual(await migrate(), [])
  })

  test('the X posts move to tables of their own, with their knowledge', async () => {
    assert.deepEqual((await q('SELECT url FROM wiki_pages')).map(r => r.url), ['https://w.example/d/chars'])
    assert.deepEqual((await q('SELECT name FROM wiki_facts')).map(r => r.name), ['よつろん'])
    assert.deepEqual((await q('SELECT url, title FROM x_pages')), [{ url: 'https://x.com/nobamangames#2026-10', title: '@nobamangames のポスト（2026年10月）' }])
    assert.deepEqual((await q('SELECT heading, text, facts_hash FROM x_sections')), [{ heading: '2026年10月 1', text: '告知', facts_hash: 'h2' }])
    assert.deepEqual((await q('SELECT kind, name, content FROM x_facts')), [{ kind: 'term', name: '告知', content: 'お知らせ' }])
    assert.deepEqual((await q('SELECT id, account FROM x_posts')), [{ id: '1', account: 'nobamangames' }])
    assert.equal((await q("SELECT to_regclass('social_posts') AS t"))[0].t, null)
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
    assert.deepEqual(columns, ['details_updated_at', 'icon_url', 'id', 'joined_at', 'log_bots', 'member_count', 'name', 'owner_id'])
  })

  test('image URLs become rows', async () => {
    const rows = await q('SELECT message_id, position, url FROM message_attachments ORDER BY position')
    assert.deepEqual(rows.map(r => [r.message_id, r.position, r.url]), [['m1', 0, 'https://cdn/a.png'], ['m1', 1, 'https://cdn/b.png']])
    const read = require('../../src/db/interfaces/postgres/read')
    assert.deepEqual((await read.getMessageById('m1')).attachment_urls, ['https://cdn/a.png', 'https://cdn/b.png'])
    assert.deepEqual((await read.getMessageById('m2')).attachment_urls, [])
  })

  test('message embeddings keep only what is not on the message', async () => {
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'message_embeddings' ORDER BY column_name")).map(r => r.column_name)
    assert.deepEqual(columns, ['embedding', 'message_id', 'model_id'])
    assert.deepEqual(await q('SELECT e.message_id, m.name AS model FROM message_embeddings e JOIN embedding_models m ON m.id = e.model_id'), [{ message_id: 'm1', model: 'model-a' }])
  })

  test('message content, image URLs and embeddings are no longer encrypted in the app', async () => {
    assert.deepEqual(await q("SELECT id, content FROM messages WHERE id IN ('m1', 'm2') ORDER BY id"), [{ id: 'm1', content: 'hi' }, { id: 'm2', content: 'hi' }])
    assert.deepEqual((await q('SELECT url FROM message_attachments ORDER BY position')).map(r => r.url), ['https://cdn/a.png', 'https://cdn/b.png'])
    assert.deepEqual(await q('SELECT message_id FROM message_embeddings'), [{ message_id: 'm1' }])
  })

  test('channels and videos are stored once; the channels servers had set become the bot\'s', async () => {
    assert.deepEqual(await q('SELECT channel_id, title, backfill_token, websub_expires_at IS NOT NULL AS websub FROM youtube_channels'), [
      { channel_id: 'UC1', title: 'チャンネル', backfill_token: null, websub: true }
    ])
    assert.deepEqual(await q('SELECT channel_id, channel_ref FROM youtube_bot_channels'), [{ channel_id: 'UC1', channel_ref: '@chan' }])
    assert.deepEqual(await q('SELECT guild_id, live_events FROM guild_youtube ORDER BY guild_id'), [
      { guild_id: 'g1', live_events: true },
      { guild_id: 'g2', live_events: false }
    ])
    assert.deepEqual(await q('SELECT video_id, channel_id FROM youtube_videos ORDER BY video_id'), [
      { video_id: 'v1', channel_id: 'UC1' }, { video_id: 'v2', channel_id: 'UC1' }
    ])
    assert.deepEqual(await q('SELECT e.video_id, e.text_hash, m.name AS model FROM youtube_video_embeddings e JOIN embedding_models m ON m.id = e.model_id'), [{ video_id: 'v1', text_hash: 'h1', model: 'model-a' }])
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

  test('embeddings are pgvector halfvecs with an HNSW index; broken ones are made again', async () => {
    const [row] = await q("SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'message_embeddings'::regclass AND attname = 'embedding'")
    assert.equal(row.type, 'halfvec(512)')
    const [m1] = await q("SELECT 1 - (embedding <=> $1::halfvec) AS score FROM message_embeddings WHERE message_id = 'm1'", [`[${['1', ...Array(511).fill('0')].join(',')}]`])
    assert.ok(Math.abs(Number(m1.score) - 1) < 0.001, 'the vector survived the conversion')
    assert.deepEqual((await q("SELECT embedded FROM messages WHERE id = 'm2'")), [{ embedded: false }])
    assert.deepEqual((await q('SELECT video_id FROM youtube_video_embeddings')), [{ video_id: 'v1' }])
    const indexes = (await q("SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%hnsw%' ORDER BY indexname")).map(r => r.indexname)
    assert.deepEqual(indexes, ['message_embeddings_hnsw', 'youtube_video_embeddings_hnsw'])
  })

  test('what a server stores refers to it; rows of servers the bot left are dropped', async () => {
    assert.deepEqual((await q('SELECT id FROM messages ORDER BY id')).map(r => r.id), ['m1', 'm2', 'm4'], 'm3 was of a server with no settings; m4 has no server recorded')
    assert.deepEqual((await q("SELECT guild_id FROM guild_youtube WHERE guild_id = 'g3'")), [], 'g3 had no guilds row')
    assert.deepEqual(await q('SELECT name FROM embedding_models'), [{ name: 'model-a' }])
    await q("DELETE FROM guilds WHERE id = 'g1'")
    assert.deepEqual((await q("SELECT id FROM messages WHERE guild_id = 'g1'")), [])
    assert.deepEqual((await q("SELECT guild_id FROM guild_youtube WHERE guild_id = 'g1'")), [])
    assert.deepEqual((await q("SELECT guild_id FROM guild_youtube_summaries WHERE guild_id = 'g1'")), [])
    await assert.rejects(q("INSERT INTO guild_youtube (guild_id) VALUES ('nowhere')"), /foreign key/)
  })
})
