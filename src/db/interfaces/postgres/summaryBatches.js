// Video summary batches still running at Gemini (migrations/027_summary_batches.sql).
const pool = require('../../clients/postgres')

async function saveBatch ({ name, guildID, channelID, requesterID, videoIDs, model }) {
  await require('./read').getGuild(guildID) // makes the guild's row if there is none yet
  await pool.query(
    `WITH batch AS (INSERT INTO youtube_summary_batches (name, guild_id, channel_id, requester_id, model) VALUES ($1, $2, $3, $4, $6) RETURNING name)
     INSERT INTO youtube_summary_batch_videos (batch_name, position, video_id)
     SELECT batch.name, v.n - 1, v.video_id FROM batch, unnest($5::text[]) WITH ORDINALITY AS v (video_id, n)`,
    [name, guildID, channelID, requesterID, videoIDs, model])
}

// [{ name, guild_id, channel_id, requester_id, video_ids, model, created_at }], oldest first.
async function runningBatches (guildID = null) {
  // Each with its videos in order (youtube_summary_batch_videos) as video_ids.
  const rows = await pool.query(
    `SELECT b.*, coalesce((SELECT array_agg(v.video_id ORDER BY v.position) FROM youtube_summary_batch_videos v WHERE v.batch_name = b.name), '{}') AS video_ids
     FROM youtube_summary_batches b WHERE $1::text IS NULL OR b.guild_id = $1 ORDER BY b.created_at`,
    [guildID])
  return rows.rows
}

async function deleteBatch (name) {
  await pool.query('DELETE FROM youtube_summary_batches WHERE name = $1', [name])
}

// Notes where a batch stands (migrations/033_batch_status.sql): Gemini's state, or the error of a
// look that failed (the state is kept then).
async function noteBatch (name, { state = null, error = null } = {}) {
  await pool.query(
    'UPDATE youtube_summary_batches SET state = coalesce($2, state), last_error = $3, checked_at = now() WHERE name = $1',
    [name, state, error ? String(error).slice(0, 500) : null])
}

module.exports = { noteBatch, saveBatch, runningBatches, deleteBatch }
