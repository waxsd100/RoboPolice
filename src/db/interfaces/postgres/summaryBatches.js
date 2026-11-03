// Video summary batches still running at Gemini (migrations/027_summary_batches.sql).
const pool = require('../../clients/postgres')

async function saveBatch ({ name, guildID, channelID, requesterID, videoIDs, model }) {
  await require('./read').getGuild(guildID) // makes the guild's row if there is none yet
  await pool.query(
    'INSERT INTO youtube_summary_batches (name, guild_id, channel_id, requester_id, video_ids, model) VALUES ($1, $2, $3, $4, $5, $6)',
    [name, guildID, channelID, requesterID, videoIDs, model])
}

// [{ name, guild_id, channel_id, requester_id, video_ids, model, created_at }], oldest first.
async function runningBatches (guildID = null) {
  const rows = guildID
    ? await pool.query('SELECT * FROM youtube_summary_batches WHERE guild_id = $1 ORDER BY created_at', [guildID])
    : await pool.query('SELECT * FROM youtube_summary_batches ORDER BY created_at')
  return rows.rows
}

async function deleteBatch (name) {
  await pool.query('DELETE FROM youtube_summary_batches WHERE name = $1', [name])
}

module.exports = { saveBatch, runningBatches, deleteBatch }
