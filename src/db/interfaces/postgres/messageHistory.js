// Past messages read back from a channel's history (historyBackfill.js) and how far back each
// channel has been read (migrations/023_message_backfill.sql, 052_consolidate_tables.sql).
const format = require('pg-format')
const pool = require('../../clients/postgres')

// { before_id, read_count, done, reached_start, limit_start, limit_max } for the channel, or null
// when it was never read.
async function backfillState (channelID) {
  const rows = await pool.query(
    `SELECT msg_before_id AS before_id, msg_read_count AS read_count, msg_done AS done,
            msg_reached_start AS reached_start, msg_limit_start AS limit_start, msg_limit_max AS limit_max
     FROM discord_channels
     WHERE id = $1 AND msg_backfill_at IS NOT NULL`,
    [channelID])
  return rows.rows[0] || null
}

// beforeID: the oldest message read; readCount: how many were read so far; done: stopped, at the
// start of the channel (reachedStart) or at the limits read with (limitStart, a Date or null;
// limitMax, a number or null).
async function saveBackfill (guildID, channelID, { beforeID = null, done = false, readCount = 0, reachedStart = false, limitStart = null, limitMax = null } = {}) {
  await require('./read').getGuild(guildID)
  await pool.query(
    `INSERT INTO discord_channels (
       id, guild_id, msg_before_id, msg_done, msg_read_count, msg_reached_start, msg_limit_start, msg_limit_max, msg_backfill_at
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, now()
     WHERE EXISTS (SELECT 1 FROM guilds WHERE id = $2)
     ON CONFLICT (id) DO UPDATE SET
       msg_before_id = $3,
       msg_done = $4,
       msg_read_count = $5,
       msg_reached_start = $6,
       msg_limit_start = $7,
       msg_limit_max = $8,
       msg_backfill_at = now()`,
    [channelID, guildID, beforeID, done, readCount, reachedStart, limitStart, limitMax])
}

// Stores messages read from history: [{ id, authorID, content, imageUrls, ts, channelID, guildID }]
// (content in the stored form, create.toStoredContent). A message already stored (received live,
// perhaps edited since) is left as it is. Resolves to how many were new.
async function saveHistory (rows) {
  if (rows.length === 0) return 0
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(format(
      `INSERT INTO messages (id, author_id, content, ts, channel_id, guild_id)
       SELECT v.id, v.author_id, v.content, v.ts::timestamptz, v.channel_id, v.guild_id FROM (VALUES %L) v(id, author_id, content, ts, channel_id, guild_id)
       WHERE EXISTS (SELECT 1 FROM guilds g WHERE g.id = v.guild_id)
       ON CONFLICT DO NOTHING RETURNING id`,
      rows.map(r => [r.id, r.authorID, r.content, r.ts, r.channelID, r.guildID])))
    const fresh = new Set(inserted.rows.map(r => r.id))
    const attachments = rows.filter(r => fresh.has(r.id)).flatMap(r => r.imageUrls.map((url, position) => [r.id, position, url]))
    if (attachments.length) {
      await client.query(format(
        `INSERT INTO message_attachments (message_id, position, url)
         SELECT v.message_id, v.position::smallint, v.url FROM (VALUES %L) v(message_id, position, url)
         ON CONFLICT DO NOTHING`,
        attachments))
    }
    await client.query('COMMIT')
    return fresh.size
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

module.exports = { backfillState, saveBackfill, saveHistory }
