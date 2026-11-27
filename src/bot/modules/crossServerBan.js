// Cross-server BAN warning & sync system (zero AI cost):
//   - Collects BAN records from ALL other guilds the bot monitors using:
//       1. Postgres member_activity_profiles (shared across every shard worker & pgvector search),
//       2. Paginated Discord REST GET /guilds/:id/bans (when bot has Ban Members permission), AND
//       3. Discord Audit Logs action_type=22 (BAN) + action_type=23 (UNBAN) when bot has View Audit Log
//          permission (works even when Ban Members permission is stripped for Wick Bot / security!).
//   - Periodically syncs each shard worker's hosted guilds' BANs into Postgres at startup & every 6h.
//   - Alerts the Discord Server Settings moderator channel (public_updates_channel_id ->
//     safety_alerts_channel_id -> fallback bot log channel) whenever:
//       1. A user banned in another server joins this server (onMemberJoin),
//       2. A user with a high-confidence match (same custom avatar or >=85% name match) to a
//          cross-server banned account joins when per-guild AI alt_detection is OFF (zero AI cost), OR
//       3. A user currently present (or high-confidence lookalike) in this server gets banned in
//          another server (onGuildBan).
//   - Advisory alert only (never auto-bans/kicks), with copy-pasteable Wick Bot V5 slash commands.

const altDB = require('../../db/interfaces/postgres/altDetection')
const altDetector = require('./altDetector')
const { formatWickSlashCommand, snowflakeToDate } = require('./wickModeration')
const { EMBED_COLORS } = require('../utils/constants')
const { ownerFirst, isOwnerGuild } = require('../utils/priority')
const { formatJstDate } = require('../utils/youtube')

const DEFAULT_COOLDOWN_HOURS = 24
const DEFAULT_MAX_LIVE_GUILDS = 20
const DEFAULT_BAN_LIST_MAX_PAGES = 5
const DEFAULT_AUDIT_BAN_MAX_PAGES = 3
const LIVE_BAN_CACHE_TTL_MS = 10 * 60 * 1000
const BAN_LIST_CACHE_TTL_MS = 60 * 60 * 1000
const BAN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5000

const liveBanCache = new Map() // `${guildID}:${userID}` -> { banned, reason, user, expiresAt }
const guildBanListCache = new Map() // guildID -> { profiles, unbanned, authoritative, expiresAt }
const alertCooldowns = new Map() // `${targetGuildID}:${userID}:${scope}` -> expiresAt
let banSyncInitialTimer = null
let banSyncIntervalTimer = null

function stopBanSync () {
  if (banSyncInitialTimer) {
    clearTimeout(banSyncInitialTimer)
    banSyncInitialTimer = null
  }
  if (banSyncIntervalTimer) {
    clearInterval(banSyncIntervalTimer)
    banSyncIntervalTimer = null
  }
}

function resetRuntimeState () {
  stopBanSync()
  liveBanCache.clear()
  guildBanListCache.clear()
  alertCooldowns.clear()
}

function isEnabled () {
  return process.env.CROSS_GUILD_BAN_ALERT !== 'false'
}

function cooldownHours () {
  const n = Number(process.env.CROSS_GUILD_BAN_COOLDOWN_HOURS)
  return process.env.CROSS_GUILD_BAN_COOLDOWN_HOURS && Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_HOURS
}

function maxLiveGuildChecks () {
  const n = Number(process.env.CROSS_GUILD_BAN_MAX_GUILDS)
  return process.env.CROSS_GUILD_BAN_MAX_GUILDS && Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_LIVE_GUILDS
}

function maxBanListPages () {
  const n = Number(process.env.CROSS_GUILD_BAN_LIST_MAX_PAGES)
  return process.env.CROSS_GUILD_BAN_LIST_MAX_PAGES && Number.isInteger(n) && n >= 1 && n <= 20 ? n : DEFAULT_BAN_LIST_MAX_PAGES
}

function setBounded (map, key, val, max = MAX_CACHE_ENTRIES) {
  if (map.has(key)) map.delete(key)
  if (map.size >= max) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
  map.set(key, val)
}

function rememberLiveBan (guildID, userID, { banned, reason = null, user = null, now = Date.now() } = {}) {
  if (!guildID || !userID) return
  setBounded(liveBanCache, `${guildID}:${userID}`, {
    banned: Boolean(banned),
    reason: reason || null,
    user: user || null,
    expiresAt: now + LIVE_BAN_CACHE_TTL_MS
  })
}

function getCachedLiveBan (guildID, userID, now = Date.now()) {
  const entry = liveBanCache.get(`${guildID}:${userID}`)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    liveBanCache.delete(`${guildID}:${userID}`)
    return null
  }
  return entry
}

function hasGuildPerm (guild, permName) {
  const botID = global.bot?.user?.id
  if (!guild?.id || !botID) return false
  const botMember = guild.members?.get?.(botID)
  if (!botMember?.permissions) return false
  if (typeof botMember.permissions.has === 'function') {
    return Boolean(botMember.permissions.has(permName) || botMember.permissions.has('administrator'))
  }
  return Boolean(botMember.permissions.json?.[permName] || botMember.permissions.json?.administrator)
}

function canCheckGuildBans (guild) {
  return hasGuildPerm(guild, 'banMembers')
}

function canViewAuditLog (guild) {
  return hasGuildPerm(guild, 'viewAuditLog')
}

function isUnknownBanError (err) {
  if (!err) return false
  return err.code === 10026 || err.status === 404 || err.statusCode === 404 || /unknown ban|404/i.test(String(err.message || ''))
}

async function checkSingleGuildBanLive (otherGuild, userID, now = Date.now()) {
  const cached = getCachedLiveBan(otherGuild.id, userID, now)
  if (cached) return { checked: true, banned: cached.banned, reason: cached.reason, user: cached.user }

  if (typeof global.bot?.requestHandler?.request !== 'function') {
    return { checked: false }
  }
  try {
    const res = await global.bot.requestHandler.request('GET', `/guilds/${otherGuild.id}/bans/${userID}`, true)
    if (res && (res.user || res.reason !== undefined)) {
      const reason = res.reason || null
      rememberLiveBan(otherGuild.id, userID, { banned: true, reason, user: res.user || null, now })
      return { checked: true, banned: true, reason, user: res.user || null }
    }
    rememberLiveBan(otherGuild.id, userID, { banned: false, now })
    return { checked: true, banned: false }
  } catch (err) {
    if (isUnknownBanError(err)) {
      rememberLiveBan(otherGuild.id, userID, { banned: false, now })
      return { checked: true, banned: false }
    }
    return { checked: false, error: err }
  }
}

function avatarUrlForRestUser (user) {
  if (!user?.id || !user?.avatar) return null
  const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`
}

function banEntryToProfile (otherGuild, entry) {
  const u = entry?.user
  if (!u?.id || u.bot) return null
  return {
    guildID: otherGuild.id,
    guildName: otherGuild.name || otherGuild.id,
    crossGuild: true,
    userID: String(u.id),
    username: u.username || null,
    globalName: u.global_name || u.globalName || null,
    nick: null,
    avatarHash: u.avatar || null,
    avatarURL: avatarUrlForRestUser(u),
    accountCreatedAt: snowflakeToDate(u.id),
    joinedAt: null,
    inviteCode: null,
    status: 'banned',
    statusAt: null,
    moderationReason: entry.reason || null,
    _source: 'ban_list'
  }
}

// Fetches paginated GET /guilds/:id/bans (up to maxPages * pageLimit entries, sorted ascending by
// user ID by Discord) so modern/recent bans on large servers are never truncated at the first page.
async function fetchGuildBanListPaginated (otherGuild, { pageLimit = 1000, maxPages = maxBanListPages() } = {}) {
  if (typeof global.bot?.requestHandler?.request !== 'function') {
    return { succeeded: false, authoritative: false, profiles: [] }
  }
  const byUser = new Map()
  let after = null
  let pages = 0
  let succeeded = false
  let reachedEnd = false

  while (pages < maxPages) {
    const qs = after ? `limit=${pageLimit}&after=${after}` : `limit=${pageLimit}`
    let raw
    try {
      raw = await global.bot.requestHandler.request('GET', `/guilds/${otherGuild.id}/bans?${qs}`, true)
    } catch (_) {
      break
    }
    if (!Array.isArray(raw)) break
    succeeded = true
    pages++
    for (const entry of raw) {
      const p = banEntryToProfile(otherGuild, entry)
      if (p) byUser.set(p.userID, p)
    }
    if (raw.length < pageLimit) {
      reachedEnd = true
      break
    }
    const lastID = raw[raw.length - 1]?.user?.id
    if (!lastID || String(lastID) === String(after)) break
    after = String(lastID)
  }

  return { succeeded, authoritative: succeeded && reachedEnd, profiles: [...byUser.values()] }
}

// Fetches recent BANs (action_type=22) and UNBANs (action_type=23) from Discord Audit Logs.
// Works WITHOUT Ban Members permission (only requires View Audit Log, which RoboPolice requests
// in /setup), returns newest bans first, and includes exact BAN timestamps + user display names.
async function fetchGuildAuditLogBans (otherGuild, { maxPages = DEFAULT_AUDIT_BAN_MAX_PAGES } = {}) {
  if (typeof global.bot?.requestHandler?.request !== 'function') {
    return { succeeded: false, profiles: [], unbanned: [] }
  }

  const unbannedAtByUser = new Map()
  try {
    const unbanRes = await global.bot.requestHandler.request('GET', `/guilds/${otherGuild.id}/audit-logs?action_type=23&limit=100`, true)
    const unbanEntries = Array.isArray(unbanRes?.audit_log_entries)
      ? unbanRes.audit_log_entries
      : (Array.isArray(unbanRes?.entries) ? unbanRes.entries : [])
    for (const e of unbanEntries) {
      const targetID = e?.target_id || e?.targetID
      if (!targetID) continue
      const ts = snowflakeToDate(e.id)
      const prev = unbannedAtByUser.get(String(targetID))
      if (!prev || (ts && ts.getTime() > prev.getTime())) {
        unbannedAtByUser.set(String(targetID), ts || new Date(0))
      }
    }
  } catch (_) {}

  const usersByID = new Map()
  const bannedByUser = new Map()
  let before = null
  let pages = 0
  let succeeded = false

  while (pages < maxPages) {
    const qs = before ? `action_type=22&limit=100&before=${before}` : 'action_type=22&limit=100'
    let res
    try {
      res = await global.bot.requestHandler.request('GET', `/guilds/${otherGuild.id}/audit-logs?${qs}`, true)
    } catch (_) {
      break
    }
    const entries = Array.isArray(res?.audit_log_entries)
      ? res.audit_log_entries
      : (Array.isArray(res?.entries) ? res.entries : null)
    if (!entries) break
    succeeded = true
    pages++

    for (const u of Array.isArray(res?.users) ? res.users : []) {
      if (u?.id) usersByID.set(String(u.id), u)
    }

    for (const e of entries) {
      const actionType = e?.action_type ?? e?.actionType
      if (actionType !== undefined && Number(actionType) !== 22) continue
      const targetID = e?.target_id || e?.targetID
      if (!targetID) continue
      const uid = String(targetID)
      // Skip users currently present in the guild (clearly unbanned & rejoined)
      if (otherGuild.members?.has?.(uid)) continue
      const banAt = snowflakeToDate(e.id)
      const unbanAt = unbannedAtByUser.get(uid)
      if (unbanAt && banAt && unbanAt.getTime() >= banAt.getTime()) continue
      if (bannedByUser.has(uid)) continue // newest-first: keep latest BAN entry

      const u = usersByID.get(uid) || e?.target || null
      if (u?.bot) continue
      bannedByUser.set(uid, {
        guildID: otherGuild.id,
        guildName: otherGuild.name || otherGuild.id,
        crossGuild: true,
        userID: uid,
        username: u?.username || null,
        globalName: u?.global_name || u?.globalName || null,
        nick: null,
        avatarHash: u?.avatar || null,
        avatarURL: u ? avatarUrlForRestUser(u) : null,
        accountCreatedAt: snowflakeToDate(uid),
        joinedAt: null,
        inviteCode: null,
        status: 'banned',
        statusAt: banAt,
        moderationReason: e.reason || null,
        _source: 'audit_log'
      })
    }

    if (entries.length < 100) break
    const lastEntryID = entries[entries.length - 1]?.id
    if (!lastEntryID || String(lastEntryID) === String(before)) break
    before = String(lastEntryID)
  }

  const unbanned = []
  for (const [uid, at] of unbannedAtByUser.entries()) {
    if (!bannedByUser.has(uid)) unbanned.push({ userID: uid, at })
  }

  return { succeeded, profiles: [...bannedByUser.values()], unbanned }
}

// Fetches and merges a guild's BAN snapshot from /bans (paginated) and/or Audit Log action_type=22/23.
// Cached for 60 minutes (invalidated on guildBanAdd / guildBanRemove).
async function fetchGuildBansSnapshot (otherGuild, { pageLimit = 1000, maxPages = maxBanListPages(), forceRefresh = false, now = Date.now() } = {}) {
  if (!otherGuild?.id) return { succeeded: false, authoritative: false, profiles: [], unbanned: [] }
  if (!forceRefresh) {
    const cached = guildBanListCache.get(otherGuild.id)
    if (cached && cached.expiresAt > now) {
      return {
        succeeded: true,
        authoritative: cached.authoritative,
        profiles: cached.profiles,
        unbanned: cached.unbanned
      }
    }
  }

  const canBans = canCheckGuildBans(otherGuild)
  const canAudit = canViewAuditLog(otherGuild)
  if (!canBans && !canAudit) {
    return { succeeded: false, authoritative: false, profiles: [], unbanned: [] }
  }

  const [banRes, auditRes] = await Promise.all([
    canBans ? fetchGuildBanListPaginated(otherGuild, { pageLimit, maxPages }) : Promise.resolve({ succeeded: false, authoritative: false, profiles: [] }),
    canAudit ? fetchGuildAuditLogBans(otherGuild) : Promise.resolve({ succeeded: false, profiles: [], unbanned: [] })
  ])

  const succeeded = banRes.succeeded || auditRes.succeeded
  if (!succeeded) {
    return { succeeded: false, authoritative: false, profiles: [], unbanned: [] }
  }

  const byUser = new Map()
  if (banRes.succeeded) {
    for (const p of banRes.profiles) byUser.set(p.userID, p)
    // Enrich /bans entries with exact BAN timestamps & reasons from Audit Log, and add newest
    // Audit Log bans if /bans hit the pagination cap (non-authoritative).
    for (const ap of auditRes.profiles) {
      const existing = byUser.get(ap.userID)
      if (existing) {
        if (!existing.statusAt && ap.statusAt) existing.statusAt = ap.statusAt
        if (!existing.moderationReason && ap.moderationReason) existing.moderationReason = ap.moderationReason
        if (!existing.globalName && ap.globalName) existing.globalName = ap.globalName
        if (!existing.avatarHash && ap.avatarHash) {
          existing.avatarHash = ap.avatarHash
          existing.avatarURL = existing.avatarURL || ap.avatarURL
        }
      } else if (!banRes.authoritative) {
        byUser.set(ap.userID, ap)
      }
    }
  } else {
    for (const ap of auditRes.profiles) byUser.set(ap.userID, ap)
  }

  const profiles = [...byUser.values()]
  const unbanned = (auditRes.unbanned || []).filter(u => !byUser.has(u.userID))
  const authoritative = Boolean(banRes.authoritative)

  setBounded(guildBanListCache, otherGuild.id, {
    profiles,
    unbanned,
    authoritative,
    expiresAt: now + BAN_LIST_CACHE_TTL_MS
  }, 200)

  return { succeeded: true, authoritative, profiles, unbanned }
}

// Finds active/recorded BANs for `userID` across all guilds other than `excludeGuildID`.
// Combines Postgres member_activity_profiles with live Discord REST checks (/bans/:userId when bot
// has Ban Members, and cached Audit Log action_type=22/23 when bot only has View Audit Log).
async function findOtherGuildBans (userID, excludeGuildID, { includeLiveCheck = true, now = Date.now() } = {}) {
  if (!userID) return []
  const byGuild = new Map()

  const dbBans = await altDB.getCrossGuildBans(userID, excludeGuildID).catch(() => [])
  for (const row of dbBans || []) {
    if (!row?.guildID || row.guildID === excludeGuildID) continue
    const cachedGuild = global.bot?.guilds?.get?.(row.guildID)
    byGuild.set(row.guildID, {
      guildID: row.guildID,
      guildName: cachedGuild?.name || row.guildName || row.guildID,
      userID,
      username: row.username || null,
      reason: row.reason || null,
      bannedAt: row.bannedAt ? new Date(row.bannedAt) : null,
      source: 'db'
    })
  }

  // Merge any positive live-cache entries from other guilds even if DB wasn't updated yet
  for (const [key, entry] of liveBanCache.entries()) {
    if (entry.expiresAt <= now || !entry.banned) continue
    const sep = key.indexOf(':')
    const gID = key.slice(0, sep)
    const uID = key.slice(sep + 1)
    if (uID !== userID || gID === excludeGuildID) continue
    const cachedGuild = global.bot?.guilds?.get?.(gID)
    const prev = byGuild.get(gID)
    byGuild.set(gID, {
      guildID: gID,
      guildName: cachedGuild?.name || prev?.guildName || gID,
      userID,
      username: entry.user?.username || prev?.username || null,
      reason: entry.reason ?? prev?.reason ?? null,
      bannedAt: prev?.bannedAt || null,
      source: 'live'
    })
  }

  const maxLive = includeLiveCheck ? maxLiveGuildChecks() : 0
  if (maxLive > 0 && global.bot?.guilds && typeof global.bot.guilds.values === 'function') {
    const otherGuilds = ownerFirst(
      [...global.bot.guilds.values()].filter(g => g && g.id !== excludeGuildID && (canCheckGuildBans(g) || canViewAuditLog(g))),
      g => g.id
    ).slice(0, maxLive)

    const banPermGuilds = otherGuilds.filter(canCheckGuildBans)
    const auditOnlyGuilds = otherGuilds.filter(g => !canCheckGuildBans(g) && canViewAuditLog(g))

    const [liveChecks, auditSnapshots] = await Promise.all([
      Promise.all(banPermGuilds.map(async otherGuild => ({
        otherGuild,
        result: await checkSingleGuildBanLive(otherGuild, userID, now)
      }))),
      Promise.all(auditOnlyGuilds.map(async otherGuild => ({
        otherGuild,
        snapshot: await fetchGuildBansSnapshot(otherGuild, { now })
      })))
    ])

    for (const { otherGuild, result } of liveChecks) {
      if (!result.checked) continue
      if (result.banned) {
        const prev = byGuild.get(otherGuild.id)
        const reason = result.reason ?? prev?.reason ?? null
        byGuild.set(otherGuild.id, {
          guildID: otherGuild.id,
          guildName: otherGuild.name || prev?.guildName || otherGuild.id,
          userID,
          username: result.user?.username || prev?.username || null,
          reason,
          bannedAt: prev?.bannedAt || null,
          source: 'live'
        })
        if (!prev) {
          altDB.markMemberStatus(otherGuild.id, userID, 'banned', {
            reason,
            at: new Date(now),
            profile: result.user
              ? {
                  userID,
                  username: result.user.username || null,
                  globalName: result.user.global_name || result.user.globalName || null,
                  avatarHash: result.user.avatar || null,
                  avatarURL: avatarUrlForRestUser(result.user),
                  accountCreatedAt: snowflakeToDate(userID)
                }
              : { userID, accountCreatedAt: snowflakeToDate(userID) }
          }).catch(() => {})
        }
      } else if (byGuild.has(otherGuild.id)) {
        // Verified 404 (not banned anymore): drop stale DB ban record and reconcile DB status
        byGuild.delete(otherGuild.id)
        altDB.markMemberStatus(otherGuild.id, userID, 'left', {
          reason: 'BAN解除（自動同期）',
          at: new Date(now),
          profile: { userID }
        }).catch(() => {})
      }
    }

    for (const { otherGuild, snapshot } of auditSnapshots) {
      if (!snapshot?.succeeded) continue
      const hit = snapshot.profiles.find(p => p.userID === userID)
      if (hit) {
        const prev = byGuild.get(otherGuild.id)
        byGuild.set(otherGuild.id, {
          guildID: otherGuild.id,
          guildName: otherGuild.name || prev?.guildName || otherGuild.id,
          userID,
          username: hit.username || prev?.username || null,
          reason: hit.moderationReason ?? prev?.reason ?? null,
          bannedAt: hit.statusAt || prev?.bannedAt || null,
          source: 'audit_log'
        })
        if (!prev) {
          altDB.markMemberStatus(otherGuild.id, userID, 'banned', {
            reason: hit.moderationReason || null,
            at: hit.statusAt || new Date(now),
            profile: hit
          }).catch(() => {})
        }
      } else if (byGuild.has(otherGuild.id)) {
        const unbanHit = (snapshot.unbanned || []).find(u => u.userID === userID)
        const prev = byGuild.get(otherGuild.id)
        if (unbanHit && (!prev.bannedAt || !unbanHit.at || unbanHit.at.getTime() >= prev.bannedAt.getTime())) {
          byGuild.delete(otherGuild.id)
          altDB.markMemberStatus(otherGuild.id, userID, 'left', {
            reason: 'BAN解除（監査ログ自動同期）',
            at: unbanHit.at || new Date(now),
            profile: { userID }
          }).catch(() => {})
        }
      }
    }
  }

  return [...byGuild.values()].sort((a, b) => {
    const ownerDiff = Number(isOwnerGuild(b.guildID)) - Number(isOwnerGuild(a.guildID))
    if (ownerDiff !== 0) return ownerDiff
    const rank = s => (s === 'live' ? 2 : s === 'audit_log' ? 1 : 0)
    const srcDiff = rank(b.source) - rank(a.source)
    if (srcDiff !== 0) return srcDiff
    return (b.bannedAt?.getTime() || 0) - (a.bannedAt?.getTime() || 0)
  })
}

// Batch scan for currently present members of `guild` who are banned in another server
// (combines Postgres, live cache, and cached REST /bans + Audit Log BAN snapshots).
async function scanGuildForCrossServerBans (guild, { limit = 20, now = Date.now() } = {}) {
  if (!guild?.id || !guild.members || typeof guild.members.values !== 'function') return []
  const membersByID = new Map()
  for (const m of guild.members.values()) {
    if (!m || m.bot || m.user?.bot) continue
    const id = m.id || m.user?.id
    if (id) membersByID.set(id, m)
  }
  if (!membersByID.size) return []

  const [dbMap, restBanned] = await Promise.all([
    altDB.getCrossGuildBansForUsers([...membersByID.keys()], guild.id).catch(() => new Map()),
    fetchOtherGuildBannedUsers(guild.id, { now }).catch(() => [])
  ])
  const combined = new Map()

  for (const [userID, rows] of dbMap.entries()) {
    const byGuild = new Map()
    for (const r of rows) {
      const cachedGuild = global.bot?.guilds?.get?.(r.guildID)
      byGuild.set(r.guildID, {
        ...r,
        guildName: cachedGuild?.name || r.guildName || r.guildID
      })
    }
    combined.set(userID, byGuild)
  }

  for (const p of restBanned || []) {
    if (!p?.userID || !p.guildID || p.guildID === guild.id || !membersByID.has(p.userID)) continue
    if (!combined.has(p.userID)) combined.set(p.userID, new Map())
    const prev = combined.get(p.userID).get(p.guildID)
    combined.get(p.userID).set(p.guildID, {
      guildID: p.guildID,
      guildName: p.guildName || prev?.guildName || p.guildID,
      userID: p.userID,
      username: p.username || prev?.username || null,
      reason: p.moderationReason ?? prev?.reason ?? null,
      bannedAt: p.statusAt || prev?.bannedAt || null,
      source: p._source === 'audit_log' ? 'audit_log' : 'live'
    })
  }

  for (const [key, entry] of liveBanCache.entries()) {
    if (entry.expiresAt <= now) continue
    const sep = key.indexOf(':')
    const gID = key.slice(0, sep)
    const uID = key.slice(sep + 1)
    if (gID === guild.id || !membersByID.has(uID)) continue
    if (!entry.banned) {
      combined.get(uID)?.delete(gID)
      continue
    }
    if (!combined.has(uID)) combined.set(uID, new Map())
    const cachedGuild = global.bot?.guilds?.get?.(gID)
    const prev = combined.get(uID).get(gID)
    combined.get(uID).set(gID, {
      guildID: gID,
      guildName: cachedGuild?.name || prev?.guildName || gID,
      userID: uID,
      username: entry.user?.username || prev?.username || null,
      reason: entry.reason ?? prev?.reason ?? null,
      bannedAt: prev?.bannedAt || null,
      source: 'live'
    })
  }

  const hits = []
  for (const [userID, byGuild] of combined.entries()) {
    if (!byGuild.size) continue
    hits.push({
      userID,
      member: membersByID.get(userID),
      bans: [...byGuild.values()]
    })
  }
  hits.sort((a, b) => b.bans.length - a.bans.length)
  return hits.slice(0, limit)
}

function isOnCooldown (targetGuildID, userID, scope, now = Date.now()) {
  const key = `${targetGuildID}:${userID}:${scope}`
  const expiresAt = alertCooldowns.get(key)
  if (!expiresAt) return false
  if (expiresAt <= now) {
    alertCooldowns.delete(key)
    return false
  }
  return true
}

function markCooldown (targetGuildID, userID, scope, now = Date.now()) {
  const hrs = cooldownHours()
  if (hrs <= 0) return
  setBounded(alertCooldowns, `${targetGuildID}:${userID}:${scope}`, now + hrs * 3600 * 1000)
}

function clamp (str, max) {
  const s = String(str ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function formatBanLine (b, lang = 'ja') {
  const guildLabel = b.guildName && b.guildName !== b.guildID
    ? `**${b.guildName}** (\`${b.guildID}\`)`
    : `\`${b.guildID}\``
  const reason = b.reason
    ? (lang === 'en' ? `Reason: ${b.reason}` : `理由: ${b.reason}`)
    : (lang === 'en' ? 'Reason: none recorded' : '理由: 記載なし')
  const when = b.bannedAt ? ` / ${formatJstDate(b.bannedAt)}` : ''
  const tag = b.source === 'live'
    ? (lang === 'en' ? ' [verified live]' : ' [リアルタイム確認済み]')
    : b.source === 'audit_log'
      ? (lang === 'en' ? ' [verified via audit log]' : ' [監査ログ確認済み]')
      : (lang === 'en' ? ' [DB record]' : ' [BOT記録]')
  return `・${guildLabel}${tag}${when}\n   └ ${clamp(reason, 180)}`
}

function buildCrossServerBanEmbed ({ user, member = null, bans = [], trigger = 'join', lang = 'ja' }) {
  const userID = user?.id || member?.id || member?.user?.id || '不明'
  const username = user?.username || member?.username || member?.user?.username || '不明'
  const displayName = member?.nick || user?.globalName || user?.global_name || member?.user?.globalName || username
  const createdAt = snowflakeToDate(userID) || (user?.createdAt ? new Date(user.createdAt) : null)
  const joinedAt = member?.joinedAt ? new Date(member.joinedAt) : null

  const userLines = [
    `<@${userID}> (**${displayName}** / @${username})`,
    `ID: \`${userID}\``,
    createdAt ? (lang === 'en' ? `Account created: ${formatJstDate(createdAt)}` : `アカウント作成日: ${formatJstDate(createdAt)}`) : '',
    joinedAt && trigger === 'existing_member_banned'
      ? (lang === 'en' ? `Joined this server: ${formatJstDate(joinedAt)}` : `このサーバーへの参加日: ${formatJstDate(joinedAt)}`)
      : ''
  ].filter(Boolean)

  const primaryGuild = bans[0]?.guildName || bans[0]?.guildID || '他サーバー'
  const wickReason = lang === 'en'
    ? `Banned in another server (${primaryGuild})`
    : `他サーバー（${primaryGuild}）でBAN済み`
  const banCmd = formatWickSlashCommand('ban', { user: userID, reason: wickReason })
  const quarantineCmd = formatWickSlashCommand('quarantine', { user: userID, reason: `${wickReason}のため確認中` })
  const casesCmd = formatWickSlashCommand('cases', { user: userID })

  const title = trigger === 'existing_member_banned'
    ? (lang === 'en' ? '🚨 Cross-Server BAN Alert: Existing Member Banned Elsewhere' : '🚨 他サーバーBAN警告（在籍中メンバーが他鯖でBAN）')
    : (lang === 'en' ? '🚨 Cross-Server BAN Alert: Banned User Joined' : '🚨 他サーバーBAN警告（他鯖でBAN済みのユーザーが参加）')

  const description = trigger === 'existing_member_banned'
    ? (lang === 'en'
        ? 'A member currently in this server was just **banned in another server** monitored by this bot. **No automatic punishment was taken** — please review below.'
        : 'このサーバーに在籍中のメンバーが、**BOT導入済みの他サーバーでBAN**されました。**自動処罰は行っていません。** 内容を確認のうえスタッフがご判断ください。')
    : (lang === 'en'
        ? `A newly joined user is **banned in ${bans.length} other server(s)** monitored by this bot. **No automatic punishment was taken** — please review below.`
        : `新しく参加したユーザーが、**BOT導入済みの他サーバー（${bans.length}件）でBANされています。** **自動処罰は行っていません。** 内容を確認のうえスタッフがご判断ください。`)

  return {
    title,
    color: EMBED_COLORS.RED,
    description,
    fields: [
      {
        name: lang === 'en' ? 'Target User' : '対象ユーザー',
        value: clamp(userLines.join('\n'), 1024)
      },
      {
        name: lang === 'en' ? `Other Server BAN Record(s) (${bans.length})` : `他サーバーでのBAN履歴（${bans.length}件）`,
        value: clamp(bans.slice(0, 6).map(b => formatBanLine(b, lang)).join('\n'), 1024)
      },
      {
        name: lang === 'en' ? 'Wick Slash Commands (Copy & Paste)' : 'Wick コマンド候補（コピペ用）',
        value: clamp([
          '```',
          banCmd,
          '```',
          `${lang === 'en' ? 'Quarantine:' : '一時隔離:'} \`${quarantineCmd}\``,
          `${lang === 'en' ? 'Check cases:' : '履歴確認:'} \`${casesCmd}\``
        ].join('\n'), 1024)
      }
    ],
    footer: {
      text: lang === 'en'
        ? 'Cross-server BAN check (alert only, no automatic kick/ban)'
        : '他サーバーBAN照合（通知のみ・自動処罰なし）'
    },
    timestamp: new Date()
  }
}

// High-precision zero-AI gate for cross-server lookalike alerts when per-guild AI alt_detection
// is OFF (or on real-time guildBanAdd in another server): requires either an exact custom avatar
// hash match OR >= 85% normalized username/display-name similarity, with score >= 30.
function isHighConfidenceCrossLookalike (heuristic) {
  if (!heuristic || heuristic.score < 30) return false
  return Boolean(heuristic.metrics?.avatarHashMatch || (heuristic.metrics?.nameSimilarity || 0) >= 0.85)
}

// Trigger 1: called on guildMemberAdd — warns this server's moderator channel if the joining
// user is banned in any other server the bot monitors. If exact ID is clean and per-guild AI
// alt_detection is OFF, runs a zero-AI-cost high-confidence lookalike check against other
// servers' BAN lists so servers still catch obvious cross-server alts without needing AI opt-in.
async function onMemberJoin (guild, member, { now = new Date() } = {}) {
  if (!isEnabled() || !guild?.id || !member) return { checked: false, alerted: false }
  const user = member.user || member
  const userID = member.id || user?.id
  if (!userID || member.bot || user?.bot) return { checked: false, alerted: false }

  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const nowDate = new Date(nowMs)
  const bans = await findOtherGuildBans(userID, guild.id, { includeLiveCheck: true, now: nowMs })
  if (bans.length > 0) {
    if (isOnCooldown(guild.id, userID, 'join', nowMs)) {
      return { checked: true, alerted: false, reason: 'cooldown', bans }
    }
    const embed = buildCrossServerBanEmbed({ user, member, bans, trigger: 'join', lang: 'ja' })
    const delivery = await altDetector.postModeratorAlert(guild, embed)
    if (delivery.sent) markCooldown(guild.id, userID, 'join', nowMs)
    return { checked: true, alerted: Boolean(delivery.sent), bans, delivery }
  }

  // Zero-AI-cost high-confidence cross-server lookalike fallback when AI alt_detection is OFF
  // (when alt_detection IS ON, altDetector.onMemberJoin runs full Stage 1 + Stage 2 Gemini review).
  if (altDetector.isCrossGuildAltEnabled()) {
    const aiAltOn = await altDB.isAltDetectionEnabled(guild.id).catch(() => false)
    if (!aiAltOn) {
      const baseProfile = altDetector.profileFromMember(member, {
        joinedAt: member.joinedAt ? new Date(member.joinedAt) : nowDate,
        status: 'active',
        statusAt: nowDate
      })
      const suspectProfile = await altDetector.enrichProfileFromRest(baseProfile, nowMs).catch(() => baseProfile)
      const crossBanned = await altDetector.loadCrossGuildBannedProfiles(guild.id, userID, { limit: 1000, now: nowDate }).catch(() => [])
      let best = null
      for (const cand of crossBanned) {
        if (!cand?.userID || cand.userID === userID) continue
        const heuristic = altDetector.scorePair({ suspectProfile, candidateProfile: cand, now: nowDate })
        if (!isHighConfidenceCrossLookalike(heuristic)) continue
        if (!best || heuristic.score > best.heuristic.score) {
          best = { candidateProfile: cand, heuristic }
        }
      }
      if (best) {
        const scope = `similar_join:${best.candidateProfile.userID}`
        if (isOnCooldown(guild.id, userID, scope, nowMs)) {
          return { checked: true, alerted: false, reason: 'cooldown', bans: [], similarMatch: best }
        }
        const recentlyAlerted = await altDB.hasRecentAlert(guild.id, userID, best.candidateProfile.userID, cooldownHours()).catch(() => false)
        if (recentlyAlerted) {
          return { checked: true, alerted: false, reason: 'cooldown', bans: [], similarMatch: best }
        }
        const delivery = await altDetector.sendAltAlert(guild, {
          suspectProfile,
          candidateProfile: best.candidateProfile,
          heuristic: best.heuristic,
          ai: null,
          trigger: 'join'
        })
        if (delivery.sent) markCooldown(guild.id, userID, scope, nowMs)
        return { checked: true, alerted: Boolean(delivery.sent), bans: [], similarMatch: best, delivery }
      }
    }
  }

  return { checked: true, alerted: false, bans: [] }
}

// Trigger 2: called on guildBanAdd — if a user banned in `sourceGuild` is currently a member of
// any OTHER guild the bot is in (or matches an existing member with a high-confidence custom
// avatar / >=85% name match), immediately warns that other guild's moderator channel.
async function onGuildBan (sourceGuild, user, { reason = null, at = new Date() } = {}) {
  if (!sourceGuild?.id || !user?.id || user.bot) return { alertedGuilds: [], similarAlertedGuilds: [] }
  const nowMs = at instanceof Date ? at.getTime() : Date.now()
  const atDate = at instanceof Date ? at : new Date(nowMs)
  rememberLiveBan(sourceGuild.id, user.id, { banned: true, reason, user, now: nowMs })
  guildBanListCache.delete(sourceGuild.id)
  if (!isEnabled()) return { alertedGuilds: [], similarAlertedGuilds: [] }
  if (!global.bot?.guilds || typeof global.bot.guilds.values !== 'function') {
    return { alertedGuilds: [], similarAlertedGuilds: [] }
  }

  const banEntry = {
    guildID: sourceGuild.id,
    guildName: sourceGuild.name || sourceGuild.id,
    userID: user.id,
    username: user.username || null,
    reason: reason || null,
    bannedAt: atDate,
    source: 'live'
  }

  const baseBannedProfile = altDetector.profileFromUser(user, {
    guildID: sourceGuild.id,
    guildName: sourceGuild.name || sourceGuild.id,
    crossGuild: true,
    status: 'banned',
    statusAt: atDate,
    moderationReason: reason || null
  })
  const bannedProfile = altDetector.isCrossGuildAltEnabled() && baseBannedProfile
    ? await altDetector.enrichProfileFromRest(baseBannedProfile, nowMs).catch(() => baseBannedProfile)
    : baseBannedProfile

  const alertedGuilds = []
  const similarAlertedGuilds = []
  const otherGuilds = ownerFirst(
    [...global.bot.guilds.values()].filter(g => g && g.id !== sourceGuild.id),
    g => g.id
  )

  for (const otherGuild of otherGuilds) {
    const existingMember = otherGuild.members?.get?.(user.id)
    if (existingMember) {
      const scope = `ban:${sourceGuild.id}`
      if (!isOnCooldown(otherGuild.id, user.id, scope, nowMs)) {
        const embed = buildCrossServerBanEmbed({
          user,
          member: existingMember,
          bans: [banEntry],
          trigger: 'existing_member_banned',
          lang: 'ja'
        })
        const delivery = await altDetector.postModeratorAlert(otherGuild, embed)
        if (delivery.sent) {
          markCooldown(otherGuild.id, user.id, scope, nowMs)
          alertedGuilds.push({ guildID: otherGuild.id, delivery })
        }
      }
      continue
    }

    // Zero-AI check for existing members of `otherGuild` strongly resembling the newly banned user
    if (altDetector.isCrossGuildAltEnabled() && bannedProfile && otherGuild.members && typeof otherGuild.members.values === 'function') {
      const matches = []
      for (const m of otherGuild.members.values()) {
        if (!m || m.bot || m.user?.bot) continue
        const mId = m.id || m.user?.id
        if (!mId || mId === user.id) continue
        const mProfile = altDetector.profileFromMember(m)
        if (!mProfile) continue
        const heuristic = altDetector.scorePair({
          suspectProfile: mProfile,
          candidateProfile: bannedProfile,
          now: atDate
        })
        if (isHighConfidenceCrossLookalike(heuristic)) {
          matches.push({ memberProfile: mProfile, heuristic })
        }
      }
      matches.sort((a, b) => b.heuristic.score - a.heuristic.score)
      for (const match of matches.slice(0, 2)) {
        const scope = `similar_ban:${sourceGuild.id}:${user.id}`
        if (isOnCooldown(otherGuild.id, match.memberProfile.userID, scope, nowMs)) continue
        const delivery = await altDetector.sendAltAlert(otherGuild, {
          suspectProfile: match.memberProfile,
          candidateProfile: bannedProfile,
          heuristic: match.heuristic,
          ai: null,
          trigger: 'join'
        })
        if (delivery.sent) {
          markCooldown(otherGuild.id, match.memberProfile.userID, scope, nowMs)
          similarAlertedGuilds.push({
            guildID: otherGuild.id,
            memberUserID: match.memberProfile.userID,
            heuristic: match.heuristic,
            delivery
          })
        }
      }
    }
  }
  return { alertedGuilds, similarAlertedGuilds }
}

function onGuildUnban (sourceGuild, user) {
  if (!sourceGuild?.id || !user?.id) return
  rememberLiveBan(sourceGuild.id, user.id, { banned: false })
  guildBanListCache.delete(sourceGuild.id)
}

// Fetches (and caches for 60 minutes) banned user profiles from other guilds where the bot has
// Ban Members and/or View Audit Log permission so similarity checks can match both historical
// bans and recent bans even without Ban Members permission.
async function fetchOtherGuildBannedUsers (excludeGuildID, { maxGuilds = DEFAULT_MAX_LIVE_GUILDS, limitPerGuild = 1000, now = Date.now() } = {}) {
  if (!isEnabled()) return []
  if (!global.bot?.guilds || typeof global.bot.guilds.values !== 'function') return []
  if (typeof global.bot?.requestHandler?.request !== 'function') return []

  const cap = Math.min(maxGuilds, maxLiveGuildChecks())
  if (cap <= 0) return []

  const otherGuilds = ownerFirst(
    [...global.bot.guilds.values()].filter(g => g && g.id !== excludeGuildID && (canCheckGuildBans(g) || canViewAuditLog(g))),
    g => g.id
  ).slice(0, cap)

  const snapshots = await Promise.all(
    otherGuilds.map(otherGuild => fetchGuildBansSnapshot(otherGuild, { pageLimit: limitPerGuild, now }).catch(() => ({ profiles: [] })))
  )

  return snapshots.flatMap(s => s.profiles || [])
}

// Syncs a single guild's BANs (from paginated /bans and/or Audit Log action_type=22/23) into
// Postgres member_activity_profiles so every shard worker and pgvector query shares them.
async function syncGuildBans (guild, { forceRefresh = true, now = Date.now() } = {}) {
  if (!isEnabled() || !guild?.id) return { synced: false, upserted: 0, unbanned: 0 }
  if (!canCheckGuildBans(guild) && !canViewAuditLog(guild)) return { synced: false, upserted: 0, unbanned: 0 }
  const snapshot = await fetchGuildBansSnapshot(guild, { forceRefresh, now })
  if (!snapshot.succeeded) return { synced: false, upserted: 0, unbanned: 0 }
  if (typeof altDB.syncGuildBannedProfiles !== 'function') {
    return { synced: false, upserted: 0, unbanned: 0 }
  }
  const res = await altDB.syncGuildBannedProfiles(guild.id, snapshot.profiles, {
    unbanned: snapshot.unbanned,
    authoritative: snapshot.authoritative
  })
  return { synced: true, count: snapshot.profiles.length, ...res }
}

// Syncs all guilds hosted on this shard worker sequentially (gentle on Discord rate limits).
async function syncAllGuildBans ({ forceRefresh = true, now = Date.now() } = {}) {
  if (!isEnabled()) return { guildsSynced: 0, totalUpserted: 0, totalUnbanned: 0 }
  if (!global.bot?.guilds || typeof global.bot.guilds.values !== 'function') {
    return { guildsSynced: 0, totalUpserted: 0, totalUnbanned: 0 }
  }
  const guilds = ownerFirst(
    [...global.bot.guilds.values()].filter(g => g && (canCheckGuildBans(g) || canViewAuditLog(g))),
    g => g.id
  )
  let guildsSynced = 0
  let totalUpserted = 0
  let totalUnbanned = 0
  for (const guild of guilds) {
    try {
      const res = await syncGuildBans(guild, { forceRefresh, now })
      if (res.synced) {
        guildsSynced++
        totalUpserted += res.upserted || 0
        totalUnbanned += res.unbanned || 0
      }
    } catch (e) {
      global.logger?.warn?.(`[XBAN]: syncGuildBans failed for guild ${guild.id}: ${e.message}`)
    }
  }
  if (guildsSynced > 0) {
    global.logger?.info?.(`[XBAN]: Synced BAN records across ${guildsSynced} guild(s) (${totalUpserted} upserted, ${totalUnbanned} unbanned reconciled)`)
  }
  return { guildsSynced, totalUpserted, totalUnbanned }
}

function startBanSync ({ initialDelayMs = 10 * 1000, intervalMs = BAN_SYNC_INTERVAL_MS } = {}) {
  if (!isEnabled() || banSyncInitialTimer || banSyncIntervalTimer) return
  banSyncInitialTimer = setTimeout(() => {
    banSyncInitialTimer = null
    syncAllGuildBans({ forceRefresh: true }).catch(e => {
      global.logger?.warn?.(`[XBAN]: Initial ban sync failed: ${e.message}`)
    })
  }, initialDelayMs)
  banSyncInitialTimer.unref?.()

  banSyncIntervalTimer = setInterval(() => {
    syncAllGuildBans({ forceRefresh: true }).catch(e => {
      global.logger?.warn?.(`[XBAN]: Scheduled ban sync failed: ${e.message}`)
    })
  }, intervalMs)
  banSyncIntervalTimer.unref?.()
}

// Resolves a banned profile for `userID` from another guild (indexed DB lookup first, then
// cached /bans + Audit Log snapshot or live single-user ban check) so /altcheck compare and
// /altcheck find work seamlessly on any cross-server banned account regardless of ban-list size.
async function findOtherGuildBannedProfile (userID, excludeGuildID, { now = Date.now() } = {}) {
  if (!userID) return null
  const dbBans = await altDB.getCrossGuildBans(userID, excludeGuildID).catch(() => [])
  let base = null
  if (dbBans.length > 0) {
    const first = dbBans[0]
    const full = await altDB.getMemberProfile(first.guildID, userID).catch(() => null)
    const cachedGuild = global.bot?.guilds?.get?.(first.guildID)
    const guildName = cachedGuild?.name || first.guildName || first.guildID
    base = full
      ? { ...full, guildID: first.guildID, guildName, crossGuild: true, _fromDB: true }
      : {
          guildID: first.guildID,
          guildName,
          crossGuild: true,
          _fromDB: true,
          userID,
          username: first.username || null,
          globalName: null,
          nick: null,
          avatarHash: null,
          avatarURL: null,
          accountCreatedAt: snowflakeToDate(userID),
          joinedAt: null,
          inviteCode: null,
          status: 'banned',
          statusAt: first.bannedAt || null,
          moderationReason: first.reason || null
        }
  }

  // Check cached snapshots across other guilds to enrich missing fields or find non-DB bans
  let cachedHit = null
  for (const [gID, entry] of guildBanListCache.entries()) {
    if (gID === excludeGuildID || entry.expiresAt <= now) continue
    const found = (entry.profiles || []).find(p => p.userID === userID)
    if (found) {
      cachedHit = found
      break
    }
  }
  if (base && cachedHit) {
    return {
      ...base,
      username: base.username || cachedHit.username || null,
      globalName: base.globalName || cachedHit.globalName || null,
      avatarHash: base.avatarHash || cachedHit.avatarHash || null,
      avatarURL: base.avatarURL || cachedHit.avatarURL || null,
      statusAt: base.statusAt || cachedHit.statusAt || null,
      moderationReason: base.moderationReason || cachedHit.moderationReason || null
    }
  }
  if (base) return base
  if (cachedHit) return cachedHit

  const bans = await findOtherGuildBans(userID, excludeGuildID, { includeLiveCheck: true, now }).catch(() => [])
  if (!bans.length) return null
  const first = bans[0]
  const liveCached = getCachedLiveBan(first.guildID, userID, now)
  const restUser = liveCached?.user || null
  const snapHit = guildBanListCache.get(first.guildID)?.profiles?.find(p => p.userID === userID) || null
  return {
    guildID: first.guildID,
    guildName: first.guildName || first.guildID,
    crossGuild: true,
    userID,
    username: restUser?.username || snapHit?.username || first.username || null,
    globalName: restUser?.global_name || restUser?.globalName || snapHit?.globalName || null,
    nick: null,
    avatarHash: restUser?.avatar || snapHit?.avatarHash || null,
    avatarURL: restUser ? avatarUrlForRestUser(restUser) : (snapHit?.avatarURL || null),
    accountCreatedAt: snowflakeToDate(userID),
    joinedAt: null,
    inviteCode: null,
    status: 'banned',
    statusAt: first.bannedAt || snapHit?.statusAt || null,
    moderationReason: first.reason || snapHit?.moderationReason || null
  }
}

module.exports = {
  resetRuntimeState,
  stopBanSync,
  isEnabled,
  cooldownHours,
  maxLiveGuildChecks,
  maxBanListPages,
  canCheckGuildBans,
  canViewAuditLog,
  rememberLiveBan,
  fetchGuildBansSnapshot,
  findOtherGuildBans,
  fetchOtherGuildBannedUsers,
  findOtherGuildBannedProfile,
  scanGuildForCrossServerBans,
  syncGuildBans,
  syncAllGuildBans,
  startBanSync,
  formatBanLine,
  buildCrossServerBanEmbed,
  isHighConfidenceCrossLookalike,
  onMemberJoin,
  onGuildBan,
  onGuildUnban
}
