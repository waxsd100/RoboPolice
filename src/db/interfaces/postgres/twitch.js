// The Twitch channels the bot follows and their archives: migrations/035_twitch.sql.
const pool = require('../../clients/postgres')

// Follows exactly these channels ([{ id, login, displayName, description }]): others are dropped
// with their archives.
async function setChannels (channels) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM twitch_channels WHERE NOT (user_id = ANY($1::text[]))', [channels.map(c => c.id)])
    for (const c of channels) {
      // A login can move to another account: the old row gives it up first.
      await client.query('DELETE FROM twitch_channels WHERE login = $1 AND user_id <> $2', [c.login, c.id])
      await client.query(
        `INSERT INTO twitch_channels (user_id, login, display_name, description) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET login = $2, display_name = $3, description = $4`,
        [c.id, c.login, c.displayName || null, c.description || null])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function listChannels () {
  return (await pool.query('SELECT user_id, login, display_name, description, synced_at FROM twitch_channels ORDER BY login')).rows
}

// Stores the channel's archives as Twitch lists them now ([{ id, title, description, url,
// publishedAt, duration, viewCount }]). With `complete` (every archive was read), the ones Twitch no
// longer lists are dropped. Resolves to how many were new.
async function saveArchives (userID, videos, { complete = false } = {}) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    const known = new Set((await client.query('SELECT video_id FROM twitch_videos WHERE user_id = $1', [userID])).rows.map(r => r.video_id))
    for (const v of videos) {
      await client.query(
        `INSERT INTO twitch_videos (video_id, user_id, title, description, url, published_at, duration, view_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (video_id) DO UPDATE SET title = $3, description = $4, url = $5, published_at = $6, duration = $7, view_count = $8`,
        [v.id, userID, v.title, v.description || null, v.url, v.publishedAt || null, v.duration || null, Number.isInteger(v.viewCount) ? v.viewCount : null])
    }
    if (complete) await client.query('DELETE FROM twitch_videos WHERE user_id = $1 AND NOT (video_id = ANY($2::text[]))', [userID, videos.map(v => v.id)])
    await client.query('UPDATE twitch_channels SET synced_at = now() WHERE user_id = $1', [userID])
    await client.query('COMMIT')
    return videos.filter(v => !known.has(v.id)).length
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// The stored archives, newest first, with their channel's name.
async function getArchives (limit = 500) {
  const rows = await pool.query(
    `SELECT v.video_id, v.user_id, c.login, c.display_name, v.title, v.description, v.url, v.published_at, v.duration, v.view_count
     FROM twitch_videos v JOIN twitch_channels c ON c.user_id = v.user_id
     ORDER BY v.published_at DESC NULLS LAST LIMIT $1`, [limit])
  return rows.rows
}

// Each channel with how many archives are stored.
async function getOverview () {
  const rows = await pool.query(
    `SELECT c.user_id, c.login, c.display_name, c.description, c.synced_at, count(v.video_id)::int AS video_count
     FROM twitch_channels c LEFT JOIN twitch_videos v ON v.user_id = c.user_id
     GROUP BY c.user_id ORDER BY c.login`)
  return rows.rows
}

module.exports = { setChannels, listChannels, saveArchives, getArchives, getOverview }
