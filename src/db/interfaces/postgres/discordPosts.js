// The streamer's Discord messages (migrations/016_discord_knowledge.sql): the
// messages, and how far each channel's history has been read. Their knowledge tables are
// discordKnowledge.js.
const pool = require('../../clients/postgres')

// Stores messages not stored yet: [{ id, guildID, channelID, channelName, authorID, authorName,
// content, createdAt }]. Resolves to the ones that were new.
async function savePosts (posts) {
  const added = []
  for (const p of posts) {
    const result = await pool.query(
      `INSERT INTO discord_posts (id, guild_id, channel_id, channel_name, author_id, author_name, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET content = $7, channel_name = $4, author_name = $6
       WHERE discord_posts.content IS DISTINCT FROM $7`,
      [p.id, p.guildID, p.channelID, p.channelName, p.authorID, p.authorName, p.content, p.createdAt])
    if (result.rowCount) added.push(p)
  }
  return added
}

// Deletes a message. Resolves to the deleted row, or null if it was not stored.
async function deletePost (id) {
  const rows = await pool.query('DELETE FROM discord_posts WHERE id = $1 RETURNING guild_id, author_id, created_at', [id])
  return rows.rows[0] || null
}

// The account's messages in the server made in `month` (YYYY-MM, in Japan time), oldest first. A
// range on created_at, so the index on the account and created_at is used.
async function postsOfMonth (guildID, authorID, month) {
  const rows = await pool.query(
    `SELECT id, channel_id, channel_name, author_name, content, created_at FROM discord_posts
     WHERE guild_id = $1 AND author_id = $2 AND created_at >= (($3 || '-01')::timestamp AT TIME ZONE 'Asia/Tokyo') AND created_at < ((($3 || '-01')::timestamp + interval '1 month') AT TIME ZONE 'Asia/Tokyo')
     ORDER BY created_at`,
    [guildID, authorID, month])
  return rows.rows
}

// { before_id, done } of the channel, or null when it was never read.
async function backfillState (channelID) {
  const rows = await pool.query('SELECT before_id, done FROM discord_backfill WHERE channel_id = $1', [channelID])
  return rows.rows[0] || null
}

async function saveBackfill (guildID, channelID, beforeID, done) {
  await pool.query(
    `INSERT INTO discord_backfill (channel_id, guild_id, before_id, done, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (channel_id) DO UPDATE SET before_id = $3, done = $4, updated_at = now()`,
    [channelID, guildID, beforeID, done])
}

module.exports = { savePosts, deletePost, postsOfMonth, backfillState, saveBackfill }
