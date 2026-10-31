// The YouTube channel each server set with /youtube, every video read from it, and summaries of
// video contents made on demand. Public YouTube data only. Channels and videos are stored once,
// however many servers set the same channel (see migrations/005_youtube.sql). Videos accumulate: a
// sync adds new ones and refreshes known ones but never drops any. A channel and its videos go when
// no server has it set any more; a summary when no server asked for it any more.
const format = require('pg-format')
const pool = require('../../clients/postgres')

// Rows per multi-row INSERT: a first sync can store thousands of videos.
const INSERT_CHUNK = 500

// A video row as the rest of the bot reads it, with its watch page.
const VIDEO_COLUMNS = `v.video_id, v.channel_id, v.title, v.description, v.published_at, v.live_status,
  v.scheduled_start, v.duration, 'https://www.youtube.com/watch?v=' || v.video_id AS url`

// What a server has set, with its channel's details: guild_id, channel_ref, channel_id,
// live_events, title, description, handle, url, synced_at, backfill_token.
const SERVER_CHANNEL = `SELECT g.guild_id, g.channel_ref, g.channel_id, g.live_events,
  c.title, c.description, c.handle, c.url, c.synced_at, c.backfill_token
  FROM guild_youtube g LEFT JOIN youtube_channels c ON c.channel_id = g.channel_id`

// What a server stores refers to its guilds row, made here if it has none yet.
async function ensureGuild (guildID) {
  await require('./read').getGuild(guildID)
}

// Deletes channels no server has set (their videos, embeddings and stream events go with them) and
// summaries no server asked for.
async function collectGarbage (db = pool) {
  await db.query('DELETE FROM youtube_channels c WHERE NOT EXISTS (SELECT 1 FROM guild_youtube g WHERE g.channel_id = c.channel_id)')
  await db.query('DELETE FROM youtube_summaries s WHERE NOT EXISTS (SELECT 1 FROM guild_youtube_summaries g WHERE g.video_id = s.video_id)')
}

// Sets the server's channel, already resolved to its ID. The same channel (however it was written)
// keeps everything accumulated; a different one drops the server's stream events and, if no other
// server has the old channel, its videos.
async function setChannel (guildID, channelRef, channelID) {
  await ensureGuild(guildID)
  const current = await pool.query('SELECT channel_id FROM guild_youtube WHERE guild_id = $1', [guildID])
  await pool.query('INSERT INTO youtube_channels (channel_id) VALUES ($1) ON CONFLICT DO NOTHING', [channelID])
  await pool.query(
    `INSERT INTO guild_youtube (guild_id, channel_ref, channel_id) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET channel_ref = $2, channel_id = $3`,
    [guildID, channelRef, channelID])
  if (current.rows.length && current.rows[0].channel_id !== channelID) {
    await pool.query('DELETE FROM youtube_live_events WHERE guild_id = $1', [guildID])
    await collectGarbage()
  }
}

async function getVideoIds (guildID) {
  const rows = await pool.query(
    'SELECT v.video_id FROM youtube_videos v JOIN guild_youtube g ON g.channel_id = v.channel_id WHERE g.guild_id = $1',
    [guildID])
  return new Set(rows.rows.map(r => r.video_id))
}

async function insertVideos (db, channelID, videos) {
  // A page re-read during backfill can repeat a video; one row per ID keeps ON CONFLICT happy.
  const unique = [...new Map(videos.map(v => [v.id, v])).values()]
  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    const rows = unique.slice(i, i + INSERT_CHUNK)
      .map(v => [v.id, channelID, v.title, v.description, v.publishedAt, v.liveStatus, v.scheduledStart, v.duration])
    await db.query(format(
      `INSERT INTO youtube_videos (video_id, channel_id, title, description, published_at, live_status, scheduled_start, duration)
       VALUES %L
       ON CONFLICT (video_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, title = EXCLUDED.title,
         description = EXCLUDED.description, published_at = COALESCE(EXCLUDED.published_at, youtube_videos.published_at),
         live_status = EXCLUDED.live_status, scheduled_start = EXCLUDED.scheduled_start, duration = EXCLUDED.duration`,
      rows))
  }
}

// Stores what a sync read from the server's channel: its details, and new and changed videos
// (titles change, upcoming streams go live), in one transaction so a failed sync leaves the store
// as it was.
async function saveSync (guildID, { channel, videos, backfillToken = null }) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO youtube_channels (channel_id, title, description, handle, url, backfill_token, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (channel_id) DO UPDATE SET title = $2, description = $3, handle = $4, url = $5, backfill_token = $6, synced_at = now()`,
      [channel.id, channel.title, channel.description, channel.handle, channel.url, backfillToken])
    // Rows set before channel IDs were stored get theirs here.
    await client.query('UPDATE guild_youtube SET channel_id = $2 WHERE guild_id = $1', [guildID, channel.id])
    await insertVideos(client, channel.id, videos)
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
  const channels = await pool.query(`${SERVER_CHANNEL} WHERE g.guild_id = $1`, [guildID])
  if (channels.rows.length === 0) return null
  const videos = await pool.query(
    `SELECT ${VIDEO_COLUMNS}, s.summary FROM youtube_videos v
     JOIN guild_youtube g ON g.channel_id = v.channel_id
     LEFT JOIN youtube_summaries s ON s.video_id = v.video_id
     WHERE g.guild_id = $1 ORDER BY v.published_at DESC NULLS LAST`,
    [guildID])
  return { channel: channels.rows[0], videos: videos.rows }
}

// The server's channel and how many videos and summaries are stored, without reading the videos.
// live_count: videos that are live or upcoming, whose state a later sync may change.
async function getOverview (guildID) {
  const rows = await pool.query(
    `SELECT sc.*,
       (SELECT count(*) FROM youtube_videos v WHERE v.channel_id = sc.channel_id)::int AS video_count,
       (SELECT count(*) FROM youtube_videos v JOIN youtube_summaries s ON s.video_id = v.video_id WHERE v.channel_id = sc.channel_id)::int AS summary_count,
       (SELECT count(*) FROM youtube_videos v WHERE v.channel_id = sc.channel_id AND v.live_status IN ('live', 'upcoming'))::int AS live_count
     FROM (${SERVER_CHANNEL} WHERE g.guild_id = $1) sc`,
    [guildID])
  return rows.rows[0] || null
}

// Every server with a channel set, for the automatic sync: [{ guild_id, channel_id, live_events }].
async function listChannels () {
  const rows = await pool.query('SELECT guild_id, channel_id, live_events FROM guild_youtube WHERE channel_id IS NOT NULL')
  return rows.rows
}

async function setLiveEvents (guildID, enabled) {
  await pool.query('UPDATE guild_youtube SET live_events = $2 WHERE guild_id = $1', [guildID, enabled])
}

// Adds or refreshes videos of the server's channel read outside a full sync (by the stream watcher).
async function upsertVideos (guildID, videos) {
  if (videos.length === 0) return
  const rows = await pool.query('SELECT channel_id FROM guild_youtube WHERE guild_id = $1 AND channel_id IS NOT NULL', [guildID])
  if (rows.rows.length === 0) return
  await insertVideos(pool, rows.rows[0].channel_id, videos)
}

// IDs of a server's videos that are live or upcoming, whose state the watcher follows.
async function getLiveVideoIds (guildID) {
  const rows = await pool.query(
    `SELECT v.video_id FROM youtube_videos v JOIN guild_youtube g ON g.channel_id = v.channel_id
     WHERE g.guild_id = $1 AND v.live_status IN ('live', 'upcoming')`,
    [guildID])
  return rows.rows.map(r => r.video_id)
}

// { video_id: { event_id, status, scheduled_start, scheduled_end } } for a server's streams that have an event.
async function getLiveEvents (guildID) {
  const rows = await pool.query('SELECT video_id, event_id, status, scheduled_start, scheduled_end FROM youtube_live_events WHERE guild_id = $1', [guildID])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, r]))
}

// ended_at is set the first time the event is completed.
async function saveLiveEvent (guildID, videoID, { eventID, status, scheduledStart, scheduledEnd }) {
  await pool.query(
    `INSERT INTO youtube_live_events (guild_id, video_id, event_id, status, scheduled_start, scheduled_end, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'completed' THEN now() END)
     ON CONFLICT (guild_id, video_id) DO UPDATE SET event_id = $3, status = $4, scheduled_start = $5, scheduled_end = $6,
       ended_at = COALESCE(youtube_live_events.ended_at, CASE WHEN $4 = 'completed' THEN now() END)`,
    [guildID, videoID, eventID, status, scheduledStart, scheduledEnd])
}

// The server's streams that are over and whose archive has no summary yet, oldest ending first:
// ended at least `waitMinutes` ago, tried fewer than `maxAttempts` times and not in the last
// `retryMinutes`. [{ video_id, url }]
async function archivesToSummarize (guildID, { waitMinutes = 30, retryMinutes = 60, maxAttempts = 3, limit = 1 } = {}) {
  const rows = await pool.query(
    `SELECT e.video_id, 'https://www.youtube.com/watch?v=' || e.video_id AS url FROM youtube_live_events e
     WHERE e.guild_id = $1 AND e.status = 'completed' AND e.ended_at < now() - make_interval(mins => $2)
       AND e.archive_attempts < $4 AND (e.archive_tried_at IS NULL OR e.archive_tried_at < now() - make_interval(mins => $3))
       AND NOT EXISTS (SELECT 1 FROM youtube_summaries s WHERE s.video_id = e.video_id)
     ORDER BY e.ended_at LIMIT $5`,
    [guildID, waitMinutes, retryMinutes, maxAttempts, limit])
  return rows.rows
}

async function recordArchiveAttempt (guildID, videoID) {
  await pool.query(
    'UPDATE youtube_live_events SET archive_attempts = archive_attempts + 1, archive_tried_at = now() WHERE guild_id = $1 AND video_id = $2',
    [guildID, videoID])
}

// Channels some server has set whose push subscription runs out before `before` (or that have none).
async function websubDue (before) {
  const rows = await pool.query(
    `SELECT c.channel_id FROM youtube_channels c
     WHERE EXISTS (SELECT 1 FROM guild_youtube g WHERE g.channel_id = c.channel_id)
       AND (c.websub_expires_at IS NULL OR c.websub_expires_at < $1)`,
    [before])
  return rows.rows.map(r => r.channel_id)
}

async function saveWebsub (channelID, expiresAt) {
  await pool.query('UPDATE youtube_channels SET websub_expires_at = $2 WHERE channel_id = $1', [channelID, expiresAt])
}

async function isKnownChannel (channelID) {
  const rows = await pool.query('SELECT 1 FROM guild_youtube WHERE channel_id = $1 LIMIT 1', [channelID])
  return rows.rows.length !== 0
}

// The stored videos of `ids`, with their channel's name: [{ video_id, title, channel_title }].
async function videoCards (ids) {
  const rows = await pool.query(
    `SELECT v.video_id, v.title, c.title AS channel_title FROM youtube_videos v
     LEFT JOIN youtube_channels c ON c.channel_id = v.channel_id WHERE v.video_id = ANY($1)`,
    [ids])
  return rows.rows
}

// The stored length of a video (ISO 8601, e.g. PT3H2M1S), or null when it is not stored.
async function videoDuration (videoID) {
  const rows = await pool.query('SELECT duration FROM youtube_videos WHERE video_id = $1', [videoID])
  return rows.rows[0]?.duration || null
}

// The stored summary of a video, whichever server asked for it first.
async function getSummary (videoID) {
  const rows = await pool.query('SELECT summary FROM youtube_summaries WHERE video_id = $1', [videoID])
  return rows.rows[0]?.summary || null
}

// Records that the server asked for the video's summary (made now, or stored already when `summary`
// is omitted).
async function saveSummary (guildID, videoID, summary = null) {
  if (summary !== null) {
    await pool.query(
      `INSERT INTO youtube_summaries (video_id, summary) VALUES ($1, $2)
       ON CONFLICT (video_id) DO UPDATE SET summary = $2, created_at = now()`,
      [videoID, summary])
  }
  await ensureGuild(guildID)
  await pool.query(
    'INSERT INTO guild_youtube_summaries (guild_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [guildID, videoID])
}

// Summaries the server asked for of videos that are not in its channel (someone linked another
// channel's video).
async function getOtherSummaries (guildID) {
  const rows = await pool.query(
    `SELECT s.video_id, s.summary FROM guild_youtube_summaries gs
     JOIN youtube_summaries s ON s.video_id = gs.video_id
     WHERE gs.guild_id = $1 AND NOT EXISTS (
       SELECT 1 FROM youtube_videos v JOIN guild_youtube g ON g.channel_id = v.channel_id
       WHERE g.guild_id = gs.guild_id AND v.video_id = gs.video_id)
     ORDER BY gs.created_at DESC`,
    [guildID])
  return rows.rows
}

// Deleting the server's guilds row deletes all of this too; this also deletes what only it used.
async function deleteGuildYouTube (guildID) {
  await pool.query('DELETE FROM guild_youtube_summaries WHERE guild_id = $1', [guildID])
  // Its stream events go with it.
  await pool.query('DELETE FROM guild_youtube WHERE guild_id = $1', [guildID])
  await collectGarbage()
}

module.exports = { setChannel, getVideoIds, saveSync, getKnowledge, getOverview, listChannels, setLiveEvents, upsertVideos, getLiveVideoIds, getLiveEvents, saveLiveEvent, archivesToSummarize, recordArchiveAttempt, websubDue, saveWebsub, isKnownChannel, videoCards, videoDuration, getSummary, saveSummary, getOtherSummaries, deleteGuildYouTube }
