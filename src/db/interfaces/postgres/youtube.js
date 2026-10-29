// The YouTube channel each server set with /youtube and what was last read from it. Public data
// from YouTube only, kept until the next sync replaces it or the bot leaves the server.
const pool = require('../../clients/postgres')

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS youtube_channels (
    guild_id TEXT PRIMARY KEY,
    channel_ref TEXT NOT NULL,
    channel_id TEXT,
    title TEXT,
    description TEXT,
    handle TEXT,
    url TEXT,
    synced_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS youtube_videos (
    guild_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    published_at TIMESTAMPTZ,
    live_status TEXT,
    scheduled_start TIMESTAMPTZ,
    duration TEXT,
    url TEXT NOT NULL,
    PRIMARY KEY (guild_id, video_id)
  )`
]

// Deployments made before these tables existed get them on first use, without a manual migration.
let ready = null
function ensureTables () {
  if (!ready) {
    ready = (async () => {
      for (const sql of SCHEMA) await pool.query(sql)
    })().catch(e => {
      ready = null
      throw e
    })
  }
  return ready
}

async function setChannelRef (guildID, channelRef) {
  await ensureTables()
  await pool.query(
    `INSERT INTO youtube_channels (guild_id, channel_ref) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_ref = $2, channel_id = NULL, title = NULL, description = NULL, handle = NULL, url = NULL, synced_at = NULL`,
    [guildID, channelRef])
  await pool.query('DELETE FROM youtube_videos WHERE guild_id = $1', [guildID])
}

// Replaces what is stored for the server with a fresh read, in one transaction so a failed sync
// never leaves half a video list.
async function saveSync (guildID, { channel, videos }) {
  await ensureTables()
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      'UPDATE youtube_channels SET channel_id = $2, title = $3, description = $4, handle = $5, url = $6, synced_at = now() WHERE guild_id = $1',
      [guildID, channel.id, channel.title, channel.description, channel.handle, channel.url])
    await client.query('DELETE FROM youtube_videos WHERE guild_id = $1', [guildID])
    for (const v of videos) {
      await client.query(
        `INSERT INTO youtube_videos (guild_id, video_id, title, description, published_at, live_status, scheduled_start, duration, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [guildID, v.id, v.title, v.description, v.publishedAt, v.liveStatus, v.scheduledStart, v.duration, v.url])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// { channel, videos } for the server, newest first, or null if no channel is set.
async function getKnowledge (guildID) {
  await ensureTables()
  const channels = await pool.query('SELECT * FROM youtube_channels WHERE guild_id = $1', [guildID])
  if (channels.rows.length === 0) return null
  const videos = await pool.query('SELECT * FROM youtube_videos WHERE guild_id = $1 ORDER BY published_at DESC NULLS LAST', [guildID])
  return { channel: channels.rows[0], videos: videos.rows }
}

async function deleteGuildYouTube (guildID) {
  await ensureTables()
  await pool.query('DELETE FROM youtube_videos WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM youtube_channels WHERE guild_id = $1', [guildID])
}

module.exports = { SCHEMA, ensureTables, setChannelRef, saveSync, getKnowledge, deleteGuildYouTube }
