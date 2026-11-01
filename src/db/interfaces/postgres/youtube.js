// The YouTube channels the bot follows (one list for every server, set with YOUTUBE_CHANNELS),
// every video read from them, and summaries of video contents made on demand. Public YouTube data
// only. A server only chooses whether the channels' streams and uploads become its events
// (live_events). Videos accumulate: a sync adds new ones and refreshes known ones but never drops
// any. A channel and its videos go when the bot no longer follows it; a summary when no server
// asked for it any more (see migrations/005_youtube.sql and 020_bot_channels.sql).
const format = require('pg-format')
const pool = require('../../clients/postgres')

// Rows per multi-row INSERT: a first sync can store thousands of videos.
const INSERT_CHUNK = 500

// A video row as the rest of the bot reads it, with its watch page.
const VIDEO_COLUMNS = `v.video_id, v.channel_id, v.title, v.description, v.published_at, v.live_status,
  v.scheduled_start, v.duration, 'https://www.youtube.com/watch?v=' || v.video_id AS url`

// The channels the bot follows, in the order set, with their details: channel_id, channel_ref,
// title, description, handle, url, synced_at, backfill_token.
const BOT_CHANNELS = `SELECT c.channel_id, b.channel_ref, c.title, c.description, c.handle, c.url, c.synced_at, c.backfill_token, b.position
  FROM youtube_bot_channels b JOIN youtube_channels c ON c.channel_id = b.channel_id`

// What a server stores refers to its guilds row, made here if it has none yet.
async function ensureGuild (guildID) {
  await require('./read').getGuild(guildID)
}

// Deletes channels the bot does not follow (their videos, embeddings and stream events go with
// them) and summaries no server asked for.
async function collectGarbage (db = pool) {
  await db.query('DELETE FROM youtube_channels c WHERE NOT EXISTS (SELECT 1 FROM youtube_bot_channels b WHERE b.channel_id = c.channel_id)')
  await db.query('DELETE FROM youtube_summaries s WHERE NOT EXISTS (SELECT 1 FROM guild_youtube_summaries g WHERE g.video_id = s.video_id)')
}

// The channels the bot follows: [{ channel_id, channel_ref, title, … }], in the order set.
async function listChannels () {
  const rows = await pool.query(`${BOT_CHANNELS} ORDER BY b.position, c.channel_id`)
  return rows.rows
}

// Makes the bot follow exactly `channels` ([{ ref, id }], already resolved), in that order. Those
// already followed keep everything accumulated; those dropped go with their videos.
async function setBotChannels (channels) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    for (const [position, { ref, id }] of channels.entries()) {
      await client.query('INSERT INTO youtube_channels (channel_id) VALUES ($1) ON CONFLICT DO NOTHING', [id])
      await client.query(
        `INSERT INTO youtube_bot_channels (channel_id, channel_ref, position) VALUES ($1, $2, $3)
         ON CONFLICT (channel_id) DO UPDATE SET channel_ref = $2, position = $3`,
        [id, ref, position])
    }
    await client.query('DELETE FROM youtube_bot_channels WHERE NOT (channel_id = ANY($1))', [channels.map(c => c.id)])
    await collectGarbage(client)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// IDs of the stored videos of the channel, or of every channel the bot follows.
async function getVideoIds (channelID = null) {
  const rows = await pool.query(
    `SELECT v.video_id FROM youtube_videos v JOIN youtube_bot_channels b ON b.channel_id = v.channel_id
     WHERE $1::text IS NULL OR v.channel_id = $1`,
    [channelID])
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

// Stores what a sync read from a channel: its details, and new and changed videos (titles change,
// upcoming streams go live), in one transaction so a failed sync leaves the store as it was.
async function saveSync ({ channel, videos, backfillToken = null }) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO youtube_channels (channel_id, title, description, handle, url, backfill_token, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (channel_id) DO UPDATE SET title = $2, description = $3, handle = $4, url = $5, backfill_token = $6, synced_at = now()`,
      [channel.id, channel.title, channel.description, channel.handle, channel.url, backfillToken])
    await insertVideos(client, channel.id, videos)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Whether the server turned stream and upload events on.
async function liveEventsOn (guildID) {
  const rows = await pool.query('SELECT live_events FROM guild_youtube WHERE guild_id = $1', [guildID])
  return !!rows.rows[0]?.live_events
}

// { channels, channel, videos, live_events } for a server: the channels the bot follows (channel:
// the first), and their videos newest first, each with its summary if one was made; null when the
// bot follows none.
async function getKnowledge (guildID) {
  const channels = await listChannels()
  if (channels.length === 0) return null
  const videos = await pool.query(
    `SELECT ${VIDEO_COLUMNS}, s.summary FROM youtube_videos v
     JOIN youtube_bot_channels b ON b.channel_id = v.channel_id
     LEFT JOIN youtube_summaries s ON s.video_id = v.video_id
     ORDER BY v.published_at DESC NULLS LAST`)
  return { channels, channel: channels[0], videos: videos.rows, live_events: await liveEventsOn(guildID) }
}

// The channels and how many videos and summaries are stored, without reading the videos:
// { channels: [{ …, video_count, summary_count, live_count }], video_count, summary_count,
// live_count, live_events }, or null when the bot follows none. live_count: videos that are live or
// upcoming, whose state a later sync may change.
async function getOverview (guildID) {
  const rows = await pool.query(
    `SELECT bc.*,
       (SELECT count(*) FROM youtube_videos v WHERE v.channel_id = bc.channel_id)::int AS video_count,
       (SELECT count(*) FROM youtube_videos v JOIN youtube_summaries s ON s.video_id = v.video_id WHERE v.channel_id = bc.channel_id)::int AS summary_count,
       (SELECT count(*) FROM youtube_videos v WHERE v.channel_id = bc.channel_id AND v.live_status IN ('live', 'upcoming'))::int AS live_count
     FROM (${BOT_CHANNELS}) bc ORDER BY bc.position, bc.channel_id`)
  if (rows.rows.length === 0) return null
  const sum = key => rows.rows.reduce((n, c) => n + c[key], 0)
  return { channels: rows.rows, video_count: sum('video_count'), summary_count: sum('summary_count'), live_count: sum('live_count'), live_events: guildID ? await liveEventsOn(guildID) : false }
}

// The servers that turned stream and upload events on: [guild_id].
async function listLiveEventGuilds () {
  const rows = await pool.query('SELECT guild_id FROM guild_youtube WHERE live_events')
  return rows.rows.map(r => r.guild_id)
}

async function setLiveEvents (guildID, enabled) {
  await ensureGuild(guildID)
  await pool.query(
    'INSERT INTO guild_youtube (guild_id, live_events) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET live_events = $2',
    [guildID, enabled])
}

// Adds or refreshes videos of a channel read outside a full sync (by the stream watcher).
async function upsertVideos (channelID, videos) {
  if (videos.length === 0) return
  await insertVideos(pool, channelID, videos)
}

// IDs of the channel's videos published since `since`.
async function recentVideoIds (channelID, since) {
  const rows = await pool.query('SELECT video_id FROM youtube_videos WHERE channel_id = $1 AND published_at > $2', [channelID, since])
  return rows.rows.map(r => r.video_id)
}

// IDs of the channel's videos that are live or upcoming, whose state the watcher follows.
async function getLiveVideoIds (channelID) {
  const rows = await pool.query(
    "SELECT video_id FROM youtube_videos WHERE channel_id = $1 AND live_status IN ('live', 'upcoming')",
    [channelID])
  return rows.rows.map(r => r.video_id)
}

// { video_id: { event_id, status, kind, scheduled_start, scheduled_end } } for a server's videos that
// have an event, optionally only those of one channel.
async function getLiveEvents (guildID, channelID = null) {
  const rows = await pool.query(
    `SELECT e.video_id, e.event_id, e.status, e.kind, e.scheduled_start, e.scheduled_end FROM youtube_live_events e
     JOIN youtube_videos v ON v.video_id = e.video_id
     WHERE e.guild_id = $1 AND ($2::text IS NULL OR v.channel_id = $2)`,
    [guildID, channelID])
  return Object.fromEntries(rows.rows.map(r => [r.video_id, r]))
}

// ended_at is set the first time the event is completed. kind: 'stream' (the default) or 'upload'.
async function saveLiveEvent (guildID, videoID, { eventID, status, scheduledStart, scheduledEnd, kind = 'stream' }) {
  await pool.query('INSERT INTO guild_youtube (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [guildID])
  await pool.query(
    `INSERT INTO youtube_live_events (guild_id, video_id, event_id, status, scheduled_start, scheduled_end, ended_at, kind)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'completed' THEN now() END, $7)
     ON CONFLICT (guild_id, video_id) DO UPDATE SET event_id = $3, status = $4, scheduled_start = $5, scheduled_end = $6,
       ended_at = COALESCE(youtube_live_events.ended_at, CASE WHEN $4 = 'completed' THEN now() END)`,
    [guildID, videoID, eventID, status, scheduledStart, scheduledEnd, kind])
}

// The server's streams that are over and whose archive has no summary yet, oldest ending first:
// ended at least `waitMinutes` ago, tried fewer than `maxAttempts` times and not in the last
// `retryMinutes`. [{ video_id, url }]
async function archivesToSummarize (guildID, { waitMinutes = 30, retryMinutes = 60, maxAttempts = 3, limit = 1 } = {}) {
  const rows = await pool.query(
    `SELECT e.video_id, 'https://www.youtube.com/watch?v=' || e.video_id AS url FROM youtube_live_events e
     WHERE e.guild_id = $1 AND e.kind = 'stream' AND e.status = 'completed' AND e.ended_at < now() - make_interval(mins => $2)
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

// Channels the bot follows whose push subscription runs out before `before` (or that have none).
async function websubDue (before) {
  const rows = await pool.query(
    `SELECT c.channel_id FROM youtube_channels c
     WHERE EXISTS (SELECT 1 FROM youtube_bot_channels b WHERE b.channel_id = c.channel_id)
       AND (c.websub_expires_at IS NULL OR c.websub_expires_at < $1)`,
    [before])
  return rows.rows.map(r => r.channel_id)
}

async function saveWebsub (channelID, expiresAt) {
  await pool.query('UPDATE youtube_channels SET websub_expires_at = $2 WHERE channel_id = $1', [channelID, expiresAt])
}

async function isKnownChannel (channelID) {
  const rows = await pool.query('SELECT 1 FROM youtube_bot_channels WHERE channel_id = $1', [channelID])
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

// Summaries the server asked for of videos that are not in the bot's channels (someone linked
// another channel's video).
async function getOtherSummaries (guildID) {
  const rows = await pool.query(
    `SELECT s.video_id, s.summary FROM guild_youtube_summaries gs
     JOIN youtube_summaries s ON s.video_id = gs.video_id
     WHERE gs.guild_id = $1 AND NOT EXISTS (
       SELECT 1 FROM youtube_videos v JOIN youtube_bot_channels b ON b.channel_id = v.channel_id
       WHERE v.video_id = gs.video_id)
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

module.exports = { setBotChannels, getVideoIds, saveSync, getKnowledge, getOverview, listChannels, listLiveEventGuilds, liveEventsOn, setLiveEvents, upsertVideos, recentVideoIds, getLiveVideoIds, getLiveEvents, saveLiveEvent, archivesToSummarize, recordArchiveAttempt, websubDue, saveWebsub, isKnownChannel, videoCards, videoDuration, getSummary, saveSummary, getOtherSummaries, deleteGuildYouTube }
