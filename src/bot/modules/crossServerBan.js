// Cross-server BAN warning system (zero AI cost):
//   - Checks both Postgres records (member_activity_profiles status='banned' across other guilds)
//     and live Discord BAN status (GET /guilds/:id/bans/:userId on other guilds where the bot has
//     Ban Members permission, reconciling historical bans and unbans automatically).
//   - Alerts the Discord Server Settings moderator channel (public_updates_channel_id ->
//     safety_alerts_channel_id -> fallback bot log channel) whenever:
//       1. A user banned in another server joins this server (onMemberJoin), OR
//       2. A user currently present in this server gets banned in another server (onGuildBan).
//   - Advisory alert only (never auto-bans/kicks), with copy-pasteable Wick Bot V5 slash commands.

const altDB = require('../../db/interfaces/postgres/altDetection')
const altDetector = require('./altDetector')
const { formatWickSlashCommand, snowflakeToDate } = require('./wickModeration')
const { EMBED_COLORS } = require('../utils/constants')
const { ownerFirst, isOwnerGuild } = require('../utils/priority')
const { formatJstDate } = require('../utils/youtube')

const DEFAULT_COOLDOWN_HOURS = 24
const DEFAULT_MAX_LIVE_GUILDS = 20
const LIVE_BAN_CACHE_TTL_MS = 10 * 60 * 1000
const BAN_LIST_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 5000

const liveBanCache = new Map() // `${guildID}:${userID}` -> { banned, reason, user, expiresAt }
const guildBanListCache = new Map() // guildID -> { profiles, expiresAt }
const alertCooldowns = new Map() // `${targetGuildID}:${userID}:${scope}` -> expiresAt

function resetRuntimeState () {
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

function canCheckGuildBans (guild) {
  const botID = global.bot?.user?.id
  if (!guild?.id || !botID) return false
  const botMember = guild.members?.get?.(botID)
  if (!botMember?.permissions) return false
  if (typeof botMember.permissions.has === 'function') {
    return Boolean(botMember.permissions.has('banMembers') || botMember.permissions.has('administrator'))
  }
  return Boolean(botMember.permissions.json?.banMembers || botMember.permissions.json?.administrator)
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

// Finds active/recorded BANs for `userID` across all guilds other than `excludeGuildID`.
// Combines Postgres member_activity_profiles with live Discord REST checks (reconciling
// historical bans from before DB tracking and filtering out stale already-unbanned records).
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
      [...global.bot.guilds.values()].filter(g => g && g.id !== excludeGuildID && canCheckGuildBans(g)),
      g => g.id
    ).slice(0, maxLive)

    const checks = await Promise.all(
      otherGuilds.map(async otherGuild => ({
        otherGuild,
        result: await checkSingleGuildBanLive(otherGuild, userID, now)
      }))
    )

    for (const { otherGuild, result } of checks) {
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
        // Backfill historical ban into DB so batch scans (/altcheck scan) also see it immediately
        if (!prev) {
          altDB.markMemberStatus(otherGuild.id, userID, 'banned', {
            reason,
            at: new Date(now),
            profile: result.user
              ? {
                  userID,
                  username: result.user.username || null,
                  globalName: result.user.global_name || result.user.globalName || null,
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
  }

  return [...byGuild.values()].sort((a, b) => {
    const ownerDiff = Number(isOwnerGuild(b.guildID)) - Number(isOwnerGuild(a.guildID))
    if (ownerDiff !== 0) return ownerDiff
    const liveDiff = Number(b.source === 'live') - Number(a.source === 'live')
    if (liveDiff !== 0) return liveDiff
    return (b.bannedAt?.getTime() || 0) - (a.bannedAt?.getTime() || 0)
  })
}

// Fast batch scan for currently present members of `guild` who are banned in another server
// (uses Postgres + live cache, zero Discord REST calls).
async function scanGuildForCrossServerBans (guild, { limit = 20, now = Date.now() } = {}) {
  if (!guild?.id || !guild.members || typeof guild.members.values !== 'function') return []
  const membersByID = new Map()
  for (const m of guild.members.values()) {
    if (!m || m.bot || m.user?.bot) continue
    const id = m.id || m.user?.id
    if (id) membersByID.set(id, m)
  }
  if (!membersByID.size) return []

  const dbMap = await altDB.getCrossGuildBansForUsers([...membersByID.keys()], guild.id).catch(() => new Map())
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
    : (lang === 'en' ? ' [DB record]' : ' [BOT記録]')
  return `・${guildLabel}${tag}${when}\n   └ ${clamp(reason, 180)}`
}

function buildCrossServerBanEmbed ({ user, member = null, bans = [], trigger = 'join', lang = 'ja' }) {
  const userID = user?.id || member?.id || member?.user?.id || '不明'
  const username = user?.username || member?.username || member?.user?.username || '不明'
  const displayName = member?.nick || user?.globalName || member?.user?.globalName || username
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

// Trigger 1: called on guildMemberAdd — warns this server's moderator channel if the joining
// user is banned in any other server the bot monitors.
async function onMemberJoin (guild, member, { now = new Date() } = {}) {
  if (!isEnabled() || !guild?.id || !member) return { checked: false, alerted: false }
  const user = member.user || member
  const userID = member.id || user?.id
  if (!userID || member.bot || user?.bot) return { checked: false, alerted: false }

  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const bans = await findOtherGuildBans(userID, guild.id, { includeLiveCheck: true, now: nowMs })
  if (!bans.length) return { checked: true, alerted: false, bans: [] }

  if (isOnCooldown(guild.id, userID, 'join', nowMs)) {
    return { checked: true, alerted: false, reason: 'cooldown', bans }
  }

  const embed = buildCrossServerBanEmbed({ user, member, bans, trigger: 'join', lang: 'ja' })
  const delivery = await altDetector.postModeratorAlert(guild, embed)
  if (delivery.sent) markCooldown(guild.id, userID, 'join', nowMs)
  return { checked: true, alerted: Boolean(delivery.sent), bans, delivery }
}

// Trigger 2: called on guildBanAdd — if a user banned in `sourceGuild` is currently a member of
// any OTHER guild the bot is in, immediately warns that other guild's moderator channel.
async function onGuildBan (sourceGuild, user, { reason = null, at = new Date() } = {}) {
  if (!sourceGuild?.id || !user?.id || user.bot) return { alertedGuilds: [] }
  const nowMs = at instanceof Date ? at.getTime() : Date.now()
  rememberLiveBan(sourceGuild.id, user.id, { banned: true, reason, user, now: nowMs })
  guildBanListCache.delete(sourceGuild.id)
  if (!isEnabled()) return { alertedGuilds: [] }
  if (!global.bot?.guilds || typeof global.bot.guilds.values !== 'function') return { alertedGuilds: [] }

  const banEntry = {
    guildID: sourceGuild.id,
    guildName: sourceGuild.name || sourceGuild.id,
    userID: user.id,
    username: user.username || null,
    reason: reason || null,
    bannedAt: at instanceof Date ? at : new Date(nowMs),
    source: 'live'
  }

  const alertedGuilds = []
  const otherGuilds = ownerFirst(
    [...global.bot.guilds.values()].filter(g => g && g.id !== sourceGuild.id),
    g => g.id
  )

  for (const otherGuild of otherGuilds) {
    const existingMember = otherGuild.members?.get?.(user.id)
    if (!existingMember) continue
    const scope = `ban:${sourceGuild.id}`
    if (isOnCooldown(otherGuild.id, user.id, scope, nowMs)) continue

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
  return { alertedGuilds }
}

function onGuildUnban (sourceGuild, user) {
  if (!sourceGuild?.id || !user?.id) return
  rememberLiveBan(sourceGuild.id, user.id, { banned: false })
  guildBanListCache.delete(sourceGuild.id)
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
    userID: u.id,
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
    moderationReason: entry.reason || null
  }
}

// Fetches (and caches for 60 minutes) banned user profiles from other guilds where the bot has
// Ban Members permission so similarity checks can match even historical bans made before DB tracking.
async function fetchOtherGuildBannedUsers (excludeGuildID, { maxGuilds = 10, limitPerGuild = 500, now = Date.now() } = {}) {
  if (!isEnabled()) return []
  if (!global.bot?.guilds || typeof global.bot.guilds.values !== 'function') return []
  if (typeof global.bot?.requestHandler?.request !== 'function') return []

  const cap = Math.min(maxGuilds, maxLiveGuildChecks())
  if (cap <= 0) return []

  const otherGuilds = ownerFirst(
    [...global.bot.guilds.values()].filter(g => g && g.id !== excludeGuildID && canCheckGuildBans(g)),
    g => g.id
  ).slice(0, cap)

  const lists = await Promise.all(otherGuilds.map(async otherGuild => {
    const cached = guildBanListCache.get(otherGuild.id)
    if (cached && cached.expiresAt > now) return cached.profiles
    try {
      const raw = await global.bot.requestHandler.request('GET', `/guilds/${otherGuild.id}/bans?limit=${limitPerGuild}`, true)
      const profiles = Array.isArray(raw)
        ? raw.map(entry => banEntryToProfile(otherGuild, entry)).filter(Boolean)
        : []
      setBounded(guildBanListCache, otherGuild.id, { profiles, expiresAt: now + BAN_LIST_CACHE_TTL_MS }, 200)
      return profiles
    } catch (_) {
      return []
    }
  }))

  return lists.flat()
}

// Resolves a banned profile for `userID` from another guild (DB first, then cached/live REST ban)
// so /altcheck compare and /altcheck find work seamlessly on cross-server banned accounts.
async function findOtherGuildBannedProfile (userID, excludeGuildID, { now = Date.now() } = {}) {
  if (!userID) return null
  const dbRows = typeof altDB.getOtherGuildBannedProfiles === 'function'
    ? await altDB.getOtherGuildBannedProfiles(excludeGuildID, { limit: 150 }).catch(() => [])
    : []
  const dbHit = dbRows.find(p => p.userID === userID)
  if (dbHit) {
    const cachedGuild = global.bot?.guilds?.get?.(dbHit.guildID)
    return { ...dbHit, guildName: cachedGuild?.name || dbHit.guildName || dbHit.guildID, crossGuild: true }
  }
  const bans = await findOtherGuildBans(userID, excludeGuildID, { includeLiveCheck: true, now }).catch(() => [])
  if (!bans.length) return null
  const first = bans[0]
  const liveCached = getCachedLiveBan(first.guildID, userID, now)
  const restUser = liveCached?.user || null
  return {
    guildID: first.guildID,
    guildName: first.guildName || first.guildID,
    crossGuild: true,
    userID,
    username: restUser?.username || first.username || null,
    globalName: restUser?.global_name || restUser?.globalName || null,
    nick: null,
    avatarHash: restUser?.avatar || null,
    avatarURL: restUser ? avatarUrlForRestUser(restUser) : null,
    accountCreatedAt: snowflakeToDate(userID),
    joinedAt: null,
    inviteCode: null,
    status: 'banned',
    statusAt: first.bannedAt || null,
    moderationReason: first.reason || null
  }
}

module.exports = {
  resetRuntimeState,
  isEnabled,
  cooldownHours,
  maxLiveGuildChecks,
  rememberLiveBan,
  findOtherGuildBans,
  fetchOtherGuildBannedUsers,
  findOtherGuildBannedProfile,
  scanGuildForCrossServerBans,
  formatBanLine,
  buildCrossServerBanEmbed,
  onMemberJoin,
  onGuildBan,
  onGuildUnban
}
