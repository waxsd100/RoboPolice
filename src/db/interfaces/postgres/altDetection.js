// Postgres storage for AI alt-account detection (migrations/068_alt_detection.sql):
// per-guild opt-in flag (guilds.alt_detection), member join/leave/kick/ban profile snapshots
// (member_activity_profiles), stored message & embedding lookups (messages), and alert history
// (alt_alerts).
const pool = require('../../clients/postgres')
const { fromStoredContent } = require('./create')

const ENABLED_CACHE_TTL_MS = 60 * 1000
const enabledCache = new Map() // guildID -> { value, expiresAt }

async function ensureGuild (guildID) {
  await require('./read').getGuild(guildID)
}

function resetCache (guildID = null) {
  if (guildID) enabledCache.delete(guildID)
  else enabledCache.clear()
}

async function isAltDetectionEnabled (guildID) {
  if (!guildID) return false
  const cached = enabledCache.get(guildID)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const { rows } = await pool.query('SELECT alt_detection FROM guilds WHERE id = $1', [guildID])
  const value = rows[0]?.alt_detection === true
  enabledCache.set(guildID, { value, expiresAt: Date.now() + ENABLED_CACHE_TTL_MS })
  return value
}

async function setAltDetection (guildID, enabled) {
  await ensureGuild(guildID)
  const value = Boolean(enabled)
  await pool.query('UPDATE guilds SET alt_detection = $2 WHERE id = $1', [guildID, value])
  enabledCache.set(guildID, { value, expiresAt: Date.now() + ENABLED_CACHE_TTL_MS })
  return value
}

async function upsertMemberProfile (guildID, profile) {
  if (!guildID || !profile?.userID) return
  await ensureGuild(guildID)
  await pool.query(
    `INSERT INTO member_activity_profiles
       (guild_id, user_id, username, global_name, nick, avatar_hash, avatar_url, account_created_at, joined_at, invite_code, status, status_at, moderation_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, member_activity_profiles.username),
       global_name = COALESCE(EXCLUDED.global_name, member_activity_profiles.global_name),
       nick = COALESCE(EXCLUDED.nick, member_activity_profiles.nick),
       avatar_hash = COALESCE(EXCLUDED.avatar_hash, member_activity_profiles.avatar_hash),
       avatar_url = COALESCE(EXCLUDED.avatar_url, member_activity_profiles.avatar_url),
       account_created_at = COALESCE(EXCLUDED.account_created_at, member_activity_profiles.account_created_at),
       joined_at = COALESCE(EXCLUDED.joined_at, member_activity_profiles.joined_at),
       invite_code = COALESCE(EXCLUDED.invite_code, member_activity_profiles.invite_code),
       status = EXCLUDED.status,
       status_at = COALESCE(EXCLUDED.status_at, member_activity_profiles.status_at),
       moderation_reason = COALESCE(EXCLUDED.moderation_reason, member_activity_profiles.moderation_reason),
       updated_at = now()`,
    [
      guildID,
      profile.userID,
      profile.username ?? null,
      profile.globalName ?? null,
      profile.nick ?? null,
      profile.avatarHash ?? null,
      profile.avatarURL ?? null,
      profile.accountCreatedAt ? new Date(profile.accountCreatedAt) : null,
      profile.joinedAt ? new Date(profile.joinedAt) : null,
      profile.inviteCode ?? null,
      profile.status || 'active',
      profile.statusAt ? new Date(profile.statusAt) : null,
      profile.moderationReason ?? null
    ]
  )
}

async function markMemberStatus (guildID, userID, status, { reason = null, at = new Date(), profile = {} } = {}) {
  return upsertMemberProfile(guildID, {
    ...profile,
    userID,
    status,
    statusAt: at,
    moderationReason: reason
  })
}

function rowToProfile (r) {
  if (!r) return null
  return {
    guildID: r.guild_id,
    userID: r.user_id,
    username: r.username || null,
    globalName: r.global_name || null,
    nick: r.nick || null,
    avatarHash: r.avatar_hash || null,
    avatarURL: r.avatar_url || null,
    accountCreatedAt: r.account_created_at ? new Date(r.account_created_at) : null,
    joinedAt: r.joined_at ? new Date(r.joined_at) : null,
    inviteCode: r.invite_code || null,
    status: r.status || 'active',
    statusAt: r.status_at ? new Date(r.status_at) : null,
    moderationReason: r.moderation_reason || null,
    updatedAt: r.updated_at ? new Date(r.updated_at) : null
  }
}

async function getMemberProfile (guildID, userID) {
  const { rows } = await pool.query(
    'SELECT * FROM member_activity_profiles WHERE guild_id = $1 AND user_id = $2',
    [guildID, userID]
  )
  return rowToProfile(rows[0])
}

// Prioritizes banned/kicked/restricted/left accounts first, then recently updated active accounts.
async function getCandidateProfiles (guildID, excludeUserID, { limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM member_activity_profiles
     WHERE guild_id = $1 AND user_id <> $2
     ORDER BY
       CASE status WHEN 'banned' THEN 0 WHEN 'kicked' THEN 1 WHEN 'restricted' THEN 2 WHEN 'left' THEN 3 ELSE 4 END,
       COALESCE(status_at, joined_at, updated_at) DESC
     LIMIT $3`,
    [guildID, excludeUserID, limit]
  )
  return rows.map(rowToProfile)
}

async function getMemberMessages (guildID, userID, { limit = 60 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, author_id, channel_id, content, ts
     FROM messages
     WHERE guild_id = $1 AND author_id = $2 AND content IS NOT NULL AND content <> ''
     ORDER BY ts DESC
     LIMIT $3`,
    [guildID, userID, limit]
  )
  return rows.map(r => ({
    id: r.id,
    authorID: r.author_id,
    channelID: r.channel_id,
    content: fromStoredContent(r.content),
    ts: r.ts ? new Date(r.ts) : new Date(0)
  })).filter(m => m.content)
}

// Returns recent messages grouped by author_id for active posters in the guild (excluding one user).
async function getRecentAuthorsMessages (guildID, excludeUserID, { authorLimit = 30, perAuthor = 30, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000)
  const { rows } = await pool.query(
    `WITH ranked_authors AS (
       SELECT author_id, max(ts) AS last_ts, count(*) AS cnt
       FROM messages
       WHERE guild_id = $1 AND author_id <> $2 AND ts >= $3 AND content IS NOT NULL AND content <> ''
       GROUP BY author_id
       HAVING count(*) >= 3
       ORDER BY last_ts DESC
       LIMIT $4
     ),
     ranked_msgs AS (
       SELECT m.id, m.author_id, m.channel_id, m.content, m.ts,
              row_number() OVER (PARTITION BY m.author_id ORDER BY m.ts DESC) AS rn
       FROM messages m
       JOIN ranked_authors a ON a.author_id = m.author_id
       WHERE m.guild_id = $1 AND m.content IS NOT NULL AND m.content <> ''
     )
     SELECT id, author_id, channel_id, content, ts
     FROM ranked_msgs
     WHERE rn <= $5
     ORDER BY author_id, ts DESC`,
    [guildID, excludeUserID, since, authorLimit, perAuthor]
  )
  const grouped = new Map()
  for (const r of rows) {
    const content = fromStoredContent(r.content)
    if (!content) continue
    if (!grouped.has(r.author_id)) grouped.set(r.author_id, [])
    grouped.get(r.author_id).push({
      id: r.id,
      authorID: r.author_id,
      channelID: r.channel_id,
      content,
      ts: r.ts ? new Date(r.ts) : new Date(0)
    })
  }
  return grouped
}

function parseVectorText (text) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
  const nums = trimmed.slice(1, -1).split(',').map(Number)
  return nums.length && nums.every(Number.isFinite) ? nums : null
}

async function getAuthorEmbeddingCentroid (guildID, userID, { limit = 40 } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT avg(embedding)::text AS centroid, count(*)::int AS cnt
       FROM (
         SELECT embedding
         FROM messages
         WHERE guild_id = $1 AND author_id = $2 AND embedding IS NOT NULL
         ORDER BY ts DESC
         LIMIT $3
       ) sub`,
      [guildID, userID, limit]
    )
    if (!rows[0]?.centroid || (rows[0].cnt || 0) < 3) return null
    return parseVectorText(rows[0].centroid)
  } catch (_) {
    return null
  }
}

async function hasRecentAlert (guildID, suspectUserID, candidateUserID, cooldownHours = 24) {
  const since = new Date(Date.now() - cooldownHours * 3600 * 1000)
  const { rows } = await pool.query(
    `SELECT 1 FROM alt_alerts
     WHERE guild_id = $1 AND suspect_user_id = $2 AND candidate_user_id = $3 AND created_at >= $4
     LIMIT 1`,
    [guildID, suspectUserID, candidateUserID, since]
  )
  return rows.length > 0
}

async function recordAlert (guildID, { suspectUserID, candidateUserID, trigger, heuristicScore, aiConfidence = null, verdict, summary = null, signals = [] }) {
  await ensureGuild(guildID)
  const { rows } = await pool.query(
    `INSERT INTO alt_alerts
       (guild_id, suspect_user_id, candidate_user_id, trigger, heuristic_score, ai_confidence, verdict, summary, signals)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id, created_at`,
    [
      guildID,
      suspectUserID,
      candidateUserID,
      trigger,
      Math.max(0, Math.min(100, Math.round(heuristicScore || 0))),
      aiConfidence == null ? null : Math.max(0, Math.min(100, Math.round(aiConfidence))),
      verdict,
      summary || null,
      JSON.stringify(Array.isArray(signals) ? signals : [])
    ]
  )
  return rows[0]
}

async function getRecentAlerts (guildID, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.*, sp.username AS suspect_username, cp.username AS candidate_username, cp.status AS candidate_status
     FROM alt_alerts a
     LEFT JOIN member_activity_profiles sp ON sp.guild_id = a.guild_id AND sp.user_id = a.suspect_user_id
     LEFT JOIN member_activity_profiles cp ON cp.guild_id = a.guild_id AND cp.user_id = a.candidate_user_id
     WHERE a.guild_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [guildID, limit]
  )
  return rows.map(r => ({
    id: r.id,
    guildID: r.guild_id,
    suspectUserID: r.suspect_user_id,
    suspectUsername: r.suspect_username || null,
    candidateUserID: r.candidate_user_id,
    candidateUsername: r.candidate_username || null,
    candidateStatus: r.candidate_status || null,
    trigger: r.trigger,
    heuristicScore: r.heuristic_score,
    aiConfidence: r.ai_confidence,
    verdict: r.verdict,
    summary: r.summary || null,
    signals: Array.isArray(r.signals) ? r.signals : [],
    createdAt: r.created_at ? new Date(r.created_at) : null
  }))
}

module.exports = {
  isAltDetectionEnabled,
  setAltDetection,
  resetCache,
  upsertMemberProfile,
  markMemberStatus,
  getMemberProfile,
  getCandidateProfiles,
  getMemberMessages,
  getRecentAuthorsMessages,
  getAuthorEmbeddingCentroid,
  hasRecentAlert,
  recordAlert,
  getRecentAlerts
}
