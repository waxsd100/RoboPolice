// Video summary batches still running at Gemini (migrations/027_summary_batches.sql, 052_consolidate_tables.sql).
const pool = require('../../clients/postgres')

async function saveBatch ({ name, guildID, channelID, requesterID, videoIDs, model }) {
  await require('./read').getGuild(guildID) // makes the guild's row if there is none yet
  const uniqueIDs = [...new Set(videoIDs)]
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO gemini_batches (name, kind, model, guild_id, channel_id, requester_id)
       VALUES ($1, 'youtube_summary', $2, $3, $4, $5)`,
      [name, model, guildID, channelID, requesterID])
    if (uniqueIDs.length) {
      await client.query(
        `INSERT INTO youtube_videos (video_id, summary_batch, summary_batch_position)
         SELECT v.video_id, $1, (v.n - 1)::smallint
         FROM unnest($2::text[]) WITH ORDINALITY AS v (video_id, n)
         ON CONFLICT (video_id) DO UPDATE SET
           summary_batch = EXCLUDED.summary_batch,
           summary_batch_position = EXCLUDED.summary_batch_position`,
        [name, uniqueIDs])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// [{ name, guild_id, channel_id, requester_id, video_ids, model, created_at }], oldest first.
async function runningBatches (guildID = null) {
  const rows = await pool.query(
    `SELECT b.name, b.guild_id, b.channel_id, b.requester_id, b.model, b.state, b.checked_at, b.last_error, b.created_at,
            coalesce((SELECT array_agg(v.video_id ORDER BY v.summary_batch_position)
                      FROM youtube_videos v WHERE v.summary_batch = b.name), '{}') AS video_ids
     FROM gemini_batches b
     WHERE b.kind = 'youtube_summary' AND ($1::text IS NULL OR b.guild_id = $1)
     ORDER BY b.created_at`,
    [guildID])
  return rows.rows
}

async function deleteBatch (name) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      'DELETE FROM youtube_videos WHERE summary_batch = $1 AND channel_id IS NULL AND summary IS NULL',
      [name])
    await client.query(
      'UPDATE youtube_videos SET summary_batch = NULL, summary_batch_position = NULL WHERE summary_batch = $1',
      [name])
    await client.query("DELETE FROM gemini_batches WHERE name = $1 AND kind = 'youtube_summary'", [name])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Notes where a batch stands (migrations/033_batch_status.sql): Gemini's state, or the error of a
// look that failed (the state is kept then).
async function noteBatch (name, { state = null, error = null } = {}) {
  await pool.query(
    "UPDATE gemini_batches SET state = coalesce($2, state), last_error = $3, checked_at = now() WHERE name = $1 AND kind = 'youtube_summary'",
    [name, state, error ? String(error).slice(0, 500) : null])
}

module.exports = { noteBatch, saveBatch, runningBatches, deleteBatch }
