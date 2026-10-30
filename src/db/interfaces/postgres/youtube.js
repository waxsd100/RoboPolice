// The YouTube channel each server set with /youtube, every video read from it, and summaries of
// video contents made on demand. Public YouTube data only. Videos accumulate: a sync adds new ones
// and refreshes known ones but never drops any. Everything goes when the server sets a different
// channel (summaries excepted) or the bot leaves the server.
const format = require('pg-format')
const pool = require('../../clients/postgres')

// Rows per multi-row INSERT: a first sync can store thousands of videos.
const INSERT_CHUNK = 500

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
  )`,
  // Keyed by video, not channel: a summary can be of any public video someone linked.
  `CREATE TABLE IF NOT EXISTS youtube_summaries (
    guild_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, video_id)
  )`,
  // Where an interrupted read of a large channel continues (a playlistItems page token).
  'ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS backfill_token TEXT'
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

// Sets the server's channel, already resolved to its ID. The same channel (however it was written)
// keeps everything accumulated; a different one starts over.
async function setChannel (guildID, channelRef, channelID) {
  await ensureTables()
  const current = await pool.query('SELECT channel_id FROM youtube_channels WHERE guild_id = $1', [guildID])
  if (current.rows[0]?.channel_id === channelID) {
    await pool.query('UPDATE youtube_channels SET channel_ref = $2 WHERE guild_id = $1', [guildID, channelRef])
    return
  }
  await pool.query(
    `INSERT INTO youtube_channels (guild_id, channel_ref, channel_id) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET channel_ref = $2, channel_id = $3, title = NULL, description = NULL,
       handle = NULL, url = NULL, synced_at = NULL, backfill_token = NULL`,
    [guildID, channelRef, channelID])
  await pool.query('DELETE FROM youtube_videos WHERE guild_id = $1', [guildID])
}

async function getVideoIds (guildID) {
  await ensureTables()
  const rows = await pool.query('SELECT video_id FROM youtube_videos WHERE guild_id = $1', [guildID])
  return new Set(rows.rows.map(r => r.video_id))
}

// Adds new videos and refreshes known ones (titles change, upcoming streams go live), in one
// transaction so a failed sync leaves the store as it was.
async function saveSync (guildID, { channel, videos, backfillToken = null }) {
  await ensureTables()
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      'UPDATE youtube_channels SET channel_id = $2, title = $3, description = $4, handle = $5, url = $6, backfill_token = $7, synced_at = now() WHERE guild_id = $1',
      [guildID, channel.id, channel.title, channel.description, channel.handle, channel.url, backfillToken])
    // A page re-read during backfill can repeat a video; one row per ID keeps ON CONFLICT happy.
    const unique = [...new Map(videos.map(v => [v.id, v])).values()]
    for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
      const rows = unique.slice(i, i + INSERT_CHUNK)
        .map(v => [guildID, v.id, v.title, v.description, v.publishedAt, v.liveStatus, v.scheduledStart, v.duration, v.url])
      await client.query(format(
        `INSERT INTO youtube_videos (guild_id, video_id, title, description, published_at, live_status, scheduled_start, duration, url)
         VALUES %L
         ON CONFLICT (guild_id, video_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
           published_at = EXCLUDED.published_at, live_status = EXCLUDED.live_status,
           scheduled_start = EXCLUDED.scheduled_start, duration = EXCLUDED.duration, url = EXCLUDED.url`,
        rows))
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// { channel, videos } for the server, newest first, each video with its summary if one was made,
// or null if no channel is set.
async function getKnowledge (guildID) {
  await ensureTables()
  const channels = await pool.query('SELECT * FROM youtube_channels WHERE guild_id = $1', [guildID])
  if (channels.rows.length === 0) return null
  const videos = await pool.query(
    `SELECT v.*, s.summary FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.guild_id = v.guild_id AND s.video_id = v.video_id
     WHERE v.guild_id = $1 ORDER BY v.published_at DESC NULLS LAST`,
    [guildID])
  return { channel: channels.rows[0], videos: videos.rows }
}

// The channel row and how many videos and summaries are stored, without reading the videos.
async function getOverview (guildID) {
  await ensureTables()
  const rows = await pool.query(
    `SELECT c.*,
       (SELECT count(*) FROM youtube_videos v WHERE v.guild_id = c.guild_id)::int AS video_count,
       (SELECT count(*) FROM youtube_summaries s WHERE s.guild_id = c.guild_id)::int AS summary_count
     FROM youtube_channels c WHERE c.guild_id = $1`,
    [guildID])
  return rows.rows[0] || null
}

async function getSummary (guildID, videoID) {
  await ensureTables()
  const rows = await pool.query('SELECT summary FROM youtube_summaries WHERE guild_id = $1 AND video_id = $2', [guildID, videoID])
  return rows.rows[0]?.summary || null
}

async function saveSummary (guildID, videoID, summary) {
  await ensureTables()
  await pool.query(
    `INSERT INTO youtube_summaries (guild_id, video_id, summary) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, video_id) DO UPDATE SET summary = $3, created_at = now()`,
    [guildID, videoID, summary])
}

// Summaries of videos that are not in the server's channel (someone linked another channel's video).
async function getOtherSummaries (guildID) {
  await ensureTables()
  const rows = await pool.query(
    `SELECT s.video_id, s.summary FROM youtube_summaries s
     WHERE s.guild_id = $1 AND NOT EXISTS (SELECT 1 FROM youtube_videos v WHERE v.guild_id = s.guild_id AND v.video_id = s.video_id)
     ORDER BY s.created_at DESC`,
    [guildID])
  return rows.rows
}

async function deleteGuildYouTube (guildID) {
  await ensureTables()
  await pool.query('DELETE FROM youtube_summaries WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM youtube_videos WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM youtube_channels WHERE guild_id = $1', [guildID])
}

module.exports = { SCHEMA, ensureTables, setChannel, getVideoIds, saveSync, getKnowledge, getOverview, getSummary, saveSummary, getOtherSummaries, deleteGuildYouTube }
