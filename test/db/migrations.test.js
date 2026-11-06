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
    await migrateTo(14)
    await q(`INSERT INTO wiki_pages (url, title) VALUES
      ('https://w.example/d/chars', 'キャラクター'), ('https://x.com/nobamangames#2026-10', '@nobamangames のポスト（2026年10月）')`)
    await q(`INSERT INTO wiki_sections (url, position, heading, text, text_hash, facts_hash) VALUES
      ('https://w.example/d/chars', 0, 'よつろん', '四葉', 'h1', 'h1'),
      ('https://x.com/nobamangames#2026-10', 0, '2026年10月 1', '告知', 'h2', 'h2')`)
    await q(`INSERT INTO wiki_facts (url, position, kind, name, content) VALUES
      ('https://w.example/d/chars', 0, 'character', 'よつろん', '四葉の笑顔'),
      ('https://x.com/nobamangames#2026-10', 0, 'term', '告知', 'お知らせ')`)
    await q("INSERT INTO social_posts (id, account, url, text, created_at) VALUES ('1', 'nobamangames', 'https://x.com/nobamangames/status/1', '告知', '2026-10-01')")

    // Up to 020: a stream's end and archive tries kept on its event, as they were before 021.
    await migrateTo(20)
    await q("UPDATE youtube_live_events SET status = 'completed', ended_at = '2026-10-05', archive_attempts = 2, archive_tried_at = '2026-10-06' WHERE video_id = 'v2'")
    // Handled with nothing to embed (it has no channel), before 024.
    await q("UPDATE messages SET embedded = true WHERE id = 'm4'")

    // Up to 029: lists in columns, names on every post, a batch's model by name, as before 030.
    await migrateTo(29)
    await q("UPDATE wiki_sections SET images = '{https://w.example/a.png,https://w.example/b.png}' WHERE url = 'https://w.example/d/chars'")
    await q("UPDATE wiki_facts SET aliases = '{よつ,yotsuron}' WHERE name = 'よつろん'")
    await q("UPDATE x_posts SET media_urls = '{https://pbs.example/1.jpg,https://pbs.example/2.mp4}'")
    await q(`INSERT INTO discord_posts (id, guild_id, channel_id, channel_name, author_id, author_name, content, created_at) VALUES
      ('d1', 'g1', 'c1', '雑談（旧）', 'u1', 'のばまん（旧）', 'やあ', '2026-10-01'),
      ('d2', 'g1', 'c1', '雑談', 'u1', 'のばまん', 'どうも', '2026-10-02')`)
    await q("INSERT INTO youtube_summary_batches (name, guild_id, channel_id, requester_id, video_ids, model) VALUES ('batches/s1', 'g1', 'c1', 'u1', '{v2,v1}', 'gemini-x')")
    await q("INSERT INTO embedding_batches (name, model) VALUES ('batches/e1', 'model-a')")
    await q("INSERT INTO embedding_batch_messages (message_id, batch_name) VALUES ('m1', 'batches/e1'), ('gone', 'batches/e1')")

    await migrate()
  })
  // Applies the migrations up to `version`.
  async function migrateTo (version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'))
    for (const m of require('../../src/db/migrate').migrationFiles().filter(m => m.version <= version)) {
      // A .js migration requires files next to it: it is loaded from where it is.
      if (m.kind === 'js') fs.writeFileSync(path.join(dir, path.basename(m.file)), `module.exports = require(${JSON.stringify(m.file)})\n`)
      else fs.copyFileSync(m.file, path.join(dir, path.basename(m.file)))
    }
    await migrate({ dir })
  }
  after(() => database.drop())

  test('records every migration, and a second run does nothing', async () => {
    const versions = (await q('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version)
    assert.deepEqual(versions, require('../../src/db/migrate').migrationFiles().map(m => m.version))
    assert.deepEqual(await migrate(), [])
  })

  test('the X posts move to their own pages, with their knowledge; every source\'s knowledge is in one set of tables', async () => {
    assert.deepEqual(await q('SELECT source, url, title FROM knowledge_pages ORDER BY source, url'), [
      { source: 'wiki', url: 'https://w.example/d/chars', title: 'キャラクター' },
      { source: 'x', url: 'https://x.com/nobamangames#2026-10', title: '@nobamangames のポスト（2026年10月）' }
    ])
    assert.deepEqual(await q("SELECT heading, text, facts_hash FROM knowledge_sections WHERE source = 'x'"), [{ heading: '2026年10月 1', text: '告知', facts_hash: 'h2' }])
    assert.deepEqual(await q('SELECT source, kind, name, content FROM knowledge_facts ORDER BY source'), [
      { source: 'wiki', kind: 'character', name: 'よつろん', content: '四葉の笑顔' },
      { source: 'x', kind: 'term', name: '告知', content: 'お知らせ' }
    ])
    assert.deepEqual((await q('SELECT id, account FROM x_posts')), [{ id: '1', account: 'nobamangames' }])
    for (const old of ['social_posts', 'wiki_pages', 'wiki_sections', 'wiki_facts', 'x_pages', 'x_sections', 'x_facts', 'discord_pages', 'discord_sections', 'discord_facts', 'web_pages', 'web_sections', 'web_facts']) {
      assert.equal((await q('SELECT to_regclass($1) AS t', [old]))[0].t, null, old)
    }
  })

  test('lists in columns become rows, in order; names are kept once; IDs refer to their rows', async () => {
    assert.deepEqual(await q('SELECT image_position, image_url FROM knowledge_section_images ORDER BY image_position'), [
      { image_position: 0, image_url: 'https://w.example/a.png' }, { image_position: 1, image_url: 'https://w.example/b.png' }
    ])
    assert.deepEqual(await q('SELECT a.alias FROM knowledge_fact_aliases a JOIN knowledge_facts f ON f.id = a.fact_id ORDER BY a.alias_position'), [{ alias: 'よつ' }, { alias: 'yotsuron' }])
    assert.deepEqual(await q('SELECT post_id, position, url FROM x_post_media ORDER BY position'), [
      { post_id: '1', position: 0, url: 'https://pbs.example/1.jpg' }, { post_id: '1', position: 1, url: 'https://pbs.example/2.mp4' }
    ])
    assert.deepEqual(await q('SELECT id, guild_id, name FROM discord_channels'), [{ id: 'c1', guild_id: 'g1', name: '雑談' }], 'the newest name')
    assert.deepEqual(await q('SELECT id, name FROM discord_users'), [{ id: 'u1', name: 'のばまん' }])
    assert.deepEqual(await q('SELECT id, channel_id, author_id, content FROM discord_posts ORDER BY id'), [
      { id: 'd1', channel_id: 'c1', author_id: 'u1', content: 'やあ' }, { id: 'd2', channel_id: 'c1', author_id: 'u1', content: 'どうも' }
    ])
    assert.deepEqual(await q('SELECT position, video_id FROM youtube_summary_batch_videos ORDER BY position'), [{ position: 0, video_id: 'v2' }, { position: 1, video_id: 'v1' }])
    assert.deepEqual(await q('SELECT b.name, m.name AS model FROM embedding_batches b JOIN embedding_models m ON m.id = b.model_id'), [{ name: 'batches/e1', model: 'model-a' }])
    assert.deepEqual(await q('SELECT message_id FROM embedding_batch_messages'), [{ message_id: 'm1' }], 'a message that is gone leaves the batch')
    await assert.rejects(q("INSERT INTO embedding_batch_messages (message_id, batch_name) VALUES ('nowhere', 'batches/e1')"), /foreign key/)
    await assert.rejects(q("INSERT INTO discord_posts (id, channel_id, author_id, content, created_at) VALUES ('d9', 'nowhere', 'u1', 'x', now())"), /foreign key/)
    // Every foreign key has an index that starts with its columns (messages.embedding_model_id aside).
    const unindexed = await q(`
      SELECT c.conrelid::regclass::text AS tbl, c.conname FROM pg_constraint c
      WHERE c.contype = 'f' AND NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
      ORDER BY 1, 2`)
    assert.deepEqual(unindexed, [{ tbl: 'messages', conname: 'messages_embedding_model_id_fkey' }])
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
    assert.deepEqual(columns, ['assistant_rules', 'debug_footer', 'details_updated_at', 'icon_url', 'id', 'joined_at', 'log_bots', 'member_count', 'name', 'owner_id', 'reply_length', 'reply_model', 'reply_thinking', 'streamer_persona', 'token_flex_at', 'token_limit_5h', 'token_limit_week', 'token_unlimited', 'youtube_live_events'])
  })

  test('image URLs become rows', async () => {
    const rows = await q('SELECT message_id, position, url FROM message_attachments ORDER BY position')
    assert.deepEqual(rows.map(r => [r.message_id, r.position, r.url]), [['m1', 0, 'https://cdn/a.png'], ['m1', 1, 'https://cdn/b.png']])
    const read = require('../../src/db/interfaces/postgres/read')
    assert.deepEqual((await read.getMessageById('m1')).attachment_urls, ['https://cdn/a.png', 'https://cdn/b.png'])
    assert.deepEqual((await read.getMessageById('m2')).attachment_urls, [])
  })

  test('a message\'s embedding is on its row: embedded, handled with nothing to embed, or still to do', async () => {
    const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map(r => r.tablename)
    assert.ok(!tables.includes('message_embeddings') && !tables.includes('youtube_video_embeddings'))
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'messages' AND column_name LIKE 'embed%' ORDER BY column_name")).map(r => r.column_name)
    assert.deepEqual(columns, ['embedding', 'embedding_model_id'])
    assert.deepEqual(await q("SELECT m.id, m.embedding IS NOT NULL AS embedded, e.name AS model FROM messages m LEFT JOIN embedding_models e ON e.id = m.embedding_model_id WHERE m.id IN ('m1', 'm2', 'm4') ORDER BY m.id"), [
      { id: 'm1', embedded: true, model: 'model-a' },
      { id: 'm2', embedded: false, model: null },
      { id: 'm4', embedded: false, model: 'model-a' }
    ])
  })

  test('message content, image URLs and embeddings are no longer encrypted in the app', async () => {
    assert.deepEqual(await q("SELECT id, content FROM messages WHERE id IN ('m1', 'm2') ORDER BY id"), [{ id: 'm1', content: 'hi' }, { id: 'm2', content: 'hi' }])
    assert.deepEqual((await q('SELECT url FROM message_attachments ORDER BY position')).map(r => r.url), ['https://cdn/a.png', 'https://cdn/b.png'])
    assert.deepEqual(await q('SELECT id FROM messages WHERE embedding IS NOT NULL'), [{ id: 'm1' }])
  })

  test('channels and videos are stored once; the channels servers had set become the bot\'s', async () => {
    assert.deepEqual(await q('SELECT channel_id, title, backfill_token, websub_expires_at IS NOT NULL AS websub FROM youtube_channels'), [
      { channel_id: 'UC1', title: 'チャンネル', backfill_token: null, websub: true }
    ])
    assert.deepEqual(await q('SELECT channel_id, channel_ref, position FROM youtube_channels'), [{ channel_id: 'UC1', channel_ref: '@chan', position: 0 }])
    assert.deepEqual(await q('SELECT id, youtube_live_events FROM guilds ORDER BY id'), [
      { id: 'g1', youtube_live_events: true },
      { id: 'g2', youtube_live_events: false }
    ])
    const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map(r => r.tablename)
    assert.ok(!tables.includes('youtube_bot_channels') && !tables.includes('guild_youtube'))
    assert.deepEqual(await q('SELECT video_id, channel_id FROM youtube_videos ORDER BY video_id'), [
      { video_id: 'v1', channel_id: 'UC1' }, { video_id: 'v2', channel_id: 'UC1' }
    ])
    assert.deepEqual(await q('SELECT v.video_id, v.embedding_hash, m.name AS model FROM youtube_videos v JOIN embedding_models m ON m.id = v.embedding_model_id'), [{ video_id: 'v1', embedding_hash: 'h1', model: 'model-a' }])
  })

  test('summaries are kept once (the newest), and who asked is kept per server', async () => {
    assert.deepEqual(await q('SELECT video_id, summary FROM youtube_summaries ORDER BY video_id'), [
      { video_id: 'v1', summary: '新しい要約' }, { video_id: 'x9', summary: '他チャンネルの要約' }
    ])
    assert.deepEqual(await q('SELECT guild_id, video_id FROM guild_youtube_summaries ORDER BY guild_id, video_id'), [
      { guild_id: 'g1', video_id: 'v1' }, { guild_id: 'g1', video_id: 'x9' }, { guild_id: 'g2', video_id: 'v1' }
    ])
  })

  test('stream events whose video is gone are dropped; a stream\'s end and archive tries move to its video', async () => {
    assert.deepEqual(await q('SELECT guild_id, video_id, event_id FROM youtube_live_events'), [{ guild_id: 'g1', video_id: 'v2', event_id: 'ev1' }])
    assert.deepEqual(await q('SELECT video_id, stream_ended_at IS NOT NULL AS ended, archive_attempts, archive_tried_at IS NOT NULL AS tried FROM youtube_videos ORDER BY video_id'), [
      { video_id: 'v1', ended: false, archive_attempts: 0, tried: false },
      { video_id: 'v2', ended: true, archive_attempts: 2, tried: true }
    ])
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'youtube_live_events' ORDER BY column_name")).map(r => r.column_name)
    assert.deepEqual(columns, ['event_id', 'guild_id', 'kind', 'scheduled_end', 'scheduled_start', 'status', 'video_id'])
    const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map(r => r.tablename)
    assert.ok(!tables.includes('youtube_websub') && !tables.some(t => t.startsWith('old_')))
  })

  test('embeddings are pgvector halfvecs with an HNSW index; broken ones are made again', async () => {
    const [row] = await q("SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'messages'::regclass AND attname = 'embedding'")
    assert.equal(row.type, 'halfvec(512)')
    const [m1] = await q("SELECT 1 - (embedding <=> $1::halfvec) AS score FROM messages WHERE id = 'm1'", [`[${['1', ...Array(511).fill('0')].join(',')}]`])
    assert.ok(Math.abs(Number(m1.score) - 1) < 0.001, 'the vector survived the conversion')
    assert.deepEqual((await q("SELECT embedding_model_id FROM messages WHERE id = 'm2'")), [{ embedding_model_id: null }])
    assert.deepEqual((await q('SELECT video_id FROM youtube_videos WHERE embedding IS NOT NULL')), [{ video_id: 'v1' }])
    const indexes = (await q("SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%hnsw%' ORDER BY indexname")).map(r => r.indexname)
    assert.deepEqual(indexes, ['messages_embedding_hnsw'])
  })

  test('what a server stores refers to it; rows of servers the bot left are dropped', async () => {
    assert.deepEqual((await q('SELECT id FROM messages ORDER BY id')).map(r => r.id), ['m1', 'm2', 'm4'], 'm3 was of a server with no settings; m4 has no server recorded')
    assert.deepEqual(await q('SELECT name FROM embedding_models'), [{ name: 'model-a' }])
    await q("DELETE FROM guilds WHERE id = 'g1'")
    assert.deepEqual((await q("SELECT id FROM messages WHERE guild_id = 'g1'")), [])
    assert.deepEqual((await q("SELECT guild_id FROM youtube_live_events WHERE guild_id = 'g1'")), [])
    assert.deepEqual((await q("SELECT guild_id FROM guild_youtube_summaries WHERE guild_id = 'g1'")), [])
    await assert.rejects(q("INSERT INTO youtube_live_events (guild_id, video_id, event_id, status) VALUES ('nowhere', 'v1', 'e', 'scheduled')"), /foreign key/)
  })
})
