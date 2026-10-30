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
  'ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS backfill_token TEXT',
  // Whether the server's streams become Discord scheduled events (/youtube liveevents).
  'ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS live_events BOOLEAN NOT NULL DEFAULT false',
  // The scheduled event made for each stream, and how far it has been taken.
  `CREATE TABLE IF NOT EXISTS youtube_live_events (
    guild_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    status TEXT NOT NULL,
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    PRIMARY KEY (guild_id, video_id)
  )`,
  // Seconds of video the summary backlog sent to Gemini, per day and key (free / paid).
  `CREATE TABLE IF NOT EXISTS youtube_summary_usage (
    day DATE NOT NULL,
    tier TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, tier)
  )`,
  // Videos the backlog could not summarize, so it moves on instead of trying them forever.
  `CREATE TABLE IF NOT EXISTS youtube_summary_failures (
    guild_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    PRIMARY KEY (guild_id, video_id)
  )`,
  // When each channel's push subscription (WebSub) runs out.
  `CREATE TABLE IF NOT EXISTS youtube_websub (
    channel_id TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
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
  await pool.query('DELETE FROM youtube_live_events WHERE guild_id = $1', [guildID])
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
// live_count: videos that are live or upcoming, whose state a later sync may change.
async function getOverview (guildID) {
  await ensureTables()
  const rows = await pool.query(
    `SELECT c.*,
       (SELECT count(*) FROM youtube_videos v WHERE v.guild_id = c.guild_id)::int AS video_count,
       (SELECT count(*) FROM youtube_summaries s WHERE s.guild_id = c.guild_id)::int AS summary_count,
       (SELECT count(*) FROM youtube_videos v WHERE v.guild_id = c.guild_id AND v.live_status IN ('live', 'upcoming'))::int AS live_count
     FROM youtube_channels c WHERE c.guild_id = $1`,
    [guildID])
  return rows.rows[0] || null
}

// Every server with a channel set, for the automatic sync: [{ guild_id, channel_id, live_events }].
async function listChannels () {
  await ensureTables()
  const rows = await pool.query('SELECT guild_id, channel_id, live_events FROM youtube_channels WHERE channel_id IS NOT NULL')
  return rows.rows
}

async function setLiveEvents (guildID, enabled) {
  await ensureTables()
  await pool.query('UPDATE youtube_channels SET live_events = $2 WHERE guild_id = $1', [guildID, enabled])
}

// Adds or refreshes videos read outside a full sync (by the stream watcher).
async function upsertVideos (guildID, videos) {
  await ensureTables()
  for (const v of videos) {
    await pool.query(
      `INSERT INTO youtube_videos (guild_id, video_id, title, description, published_at, live_status, scheduled_start, duration, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (guild_id, video_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
         live_status = EXCLUDED.live_status, scheduled_start = EXCLUDED.scheduled_start, duration = EXCLUDED.duration`,
      [guildID, v.id, v.title, v.description, v.publishedAt, v.liveStatus, v.scheduledStart, v.duration, v.url])
  }
}

// IDs of a server's videos that are live or upcoming, whose state the watcher follows.
async function getLiveVideoIds (guildID) {
  await ensureTables()
  const rows = await pool.query("SELECT video_id FROM youtube_videos WHERE guild_id = $1 AND live_status IN ('live', 'upcoming')", [guildID])
  return rows.rows.map(r => r.video_id)
}

// { video_id: { event_id, status, scheduled_start, scheduled_end } } for a server's streams that have an event.
async function getLiveEvents (guildID) {
  await ensureTables()
  const rows = await pool.query('SELECT video_id, event_id, status, scheduled_start, scheduled_end FROM youtube_live_events WHERE guild_id = $1', [guildID])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, r]))
}

async function saveLiveEvent (guildID, videoID, { eventID, status, scheduledStart, scheduledEnd }) {
  await ensureTables()
  await pool.query(
    `INSERT INTO youtube_live_events (guild_id, video_id, event_id, status, scheduled_start, scheduled_end) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id, video_id) DO UPDATE SET event_id = $3, status = $4, scheduled_start = $5, scheduled_end = $6`,
    [guildID, videoID, eventID, status, scheduledStart, scheduledEnd])
}

// Channels whose push subscription runs out before `before` (or that have none).
async function websubDue (before) {
  await ensureTables()
  const rows = await pool.query(
    `SELECT DISTINCT c.channel_id FROM youtube_channels c LEFT JOIN youtube_websub w ON w.channel_id = c.channel_id
     WHERE c.channel_id IS NOT NULL AND (w.expires_at IS NULL OR w.expires_at < $1)`,
    [before])
  return rows.rows.map(r => r.channel_id)
}

async function saveWebsub (channelID, expiresAt) {
  await ensureTables()
  await pool.query(
    'INSERT INTO youtube_websub (channel_id, expires_at) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET expires_at = $2',
    [channelID, expiresAt])
}

async function isKnownChannel (channelID) {
  await ensureTables()
  const rows = await pool.query('SELECT 1 FROM youtube_channels WHERE channel_id = $1 LIMIT 1', [channelID])
  return rows.rows.length !== 0
}

// The newest videos, across servers, that have no summary yet and can be summarized: not live or
// upcoming, with a known length, and not given up on. [{ guild_id, video_id, title, url, duration }].
async function videosForSummaryBacklog (limit, maxAttempts) {
  await ensureTables()
  const rows = await pool.query(
    `SELECT v.guild_id, v.video_id, v.title, v.url, v.duration FROM youtube_videos v
     LEFT JOIN youtube_summaries s ON s.guild_id = v.guild_id AND s.video_id = v.video_id
     LEFT JOIN youtube_summary_failures f ON f.guild_id = v.guild_id AND f.video_id = v.video_id
     WHERE s.video_id IS NULL AND v.live_status = 'none' AND v.duration IS NOT NULL
       AND COALESCE(f.attempts, 0) < $2
     ORDER BY v.published_at DESC NULLS LAST LIMIT $1`,
    [limit, maxAttempts])
  return rows.rows
}

// Seconds used by `tier` from `since` to `until` (inclusive dates, YYYY-MM-DD).
async function summaryUsage (tier, since, until = since) {
  await ensureTables()
  const rows = await pool.query('SELECT COALESCE(SUM(seconds), 0)::int AS seconds FROM youtube_summary_usage WHERE tier = $1 AND day BETWEEN $2 AND $3', [tier, since, until])
  return rows.rows[0].seconds
}

async function addSummaryUsage (tier, day, seconds) {
  await ensureTables()
  await pool.query(
    `INSERT INTO youtube_summary_usage (day, tier, seconds) VALUES ($1, $2, $3)
     ON CONFLICT (day, tier) DO UPDATE SET seconds = youtube_summary_usage.seconds + $3`,
    [day, tier, seconds])
}

async function recordSummaryFailure (guildID, videoID, reason) {
  await ensureTables()
  await pool.query(
    `INSERT INTO youtube_summary_failures (guild_id, video_id, attempts, reason) VALUES ($1, $2, 1, $3)
     ON CONFLICT (guild_id, video_id) DO UPDATE SET attempts = youtube_summary_failures.attempts + 1, reason = $3`,
    [guildID, videoID, String(reason).slice(0, 500)])
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
  await pool.query('DELETE FROM youtube_live_events WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM youtube_summary_failures WHERE guild_id = $1', [guildID])
  await pool.query('DELETE FROM youtube_channels WHERE guild_id = $1', [guildID])
}

module.exports = { SCHEMA, ensureTables, setChannel, getVideoIds, saveSync, getKnowledge, getOverview, listChannels, setLiveEvents, upsertVideos, videosForSummaryBacklog, summaryUsage, addSummaryUsage, recordSummaryFailure, getLiveVideoIds, getLiveEvents, saveLiveEvent, websubDue, saveWebsub, isKnownChannel, getSummary, saveSummary, getOtherSummaries, deleteGuildYouTube }
