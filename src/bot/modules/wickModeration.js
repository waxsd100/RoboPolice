// Wick Bot (https://wickbot.com/) integration & moderation advisor:
//   - Parses Wick Bot V5/V4 moderation log / case embeds in real time and on demand
//   - Reads the server's actual rules channel (guild.rulesChannelID + rules-named channels)
//   - Reads Discord Audit Logs (including actions executed by Wick Bot) and RoboPolice DB
//     moderation profiles, alt-account alerts, and deleted/mod-deleted message snapshots
//   - Formats verified copy-pasteable Wick Bot V5 slash commands
// Note: Discord's API does not allow one bot to invoke another bot's slash commands directly,
// so RoboPolice integrates by reading Wick's modlog/case embeds + audit logs, syncing Wick
// punishments into alt-detection profiles, and generating copy-pasteable Wick slash commands.

const altDB = require('../../db/interfaces/postgres/altDetection')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { formatJstDate } = require('../utils/youtube')
const { isUnsafeMinorContent } = require('../utils/minorSafety')

const WICK_BOT_ID = '536991182035746816'
const WICK_NAME_PATTERN = /\bwick\b/i
const DISCORD_EPOCH = 1420070400000
const DEFAULT_OFFENDER_ROLE_IDS = ['882586674717138954']
const MODERATOR_PERMISSIONS = ['manageGuild', 'manageMessages', 'moderateMembers', 'kickMembers', 'banMembers']

const RULES_CHANNEL_PATTERN = /(?:ルール|rules?|規約|ガイドライン|guidelines?)/i
const WICK_LOG_CHANNEL_PATTERN = /(?:wick|mod[-_]?logs?|punish|処罰|処置|警告|ban[-_]?log|case|staff[-_]?log|audit|管理|運営|ログ|logs?)/i

const RULES_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_RULES_CHARS = 5000
const MAX_WICK_CASES_PER_GUILD = 200
const MAX_WICK_LOG_CHANNELS = 10
const MAX_WICK_MESSAGES_PER_CHANNEL = 50

// Per-guild caches (resettable in tests)
const rulesCache = new Map() // guildID -> { channels, text, truncated, expiresAt }
const rememberedWickChannels = new Map() // guildID -> Set<channelID>
const recentWickCases = new Map() // guildID -> Array<parsedCase>

function resetRuntimeState () {
  rulesCache.clear()
  rememberedWickChannels.clear()
  recentWickCases.clear()
}

function snowflakeToDate (id) {
  if (!id || !/^\d{15,22}$/.test(String(id))) return null
  try {
    const ms = Number((BigInt(String(id)) >> 22n) + BigInt(DISCORD_EPOCH))
    return Number.isFinite(ms) ? new Date(ms) : null
  } catch (_) {
    return null
  }
}

function isModerator (member, guild) {
  if (!member || !guild) return false
  const id = member.id || member.user?.id
  if (!id) return false
  const hasPerm = p => {
    if (!member.permissions) return false
    if (typeof member.permissions.has === 'function') return Boolean(member.permissions.has(p))
    return Boolean(member.permissions.json?.[p])
  }
  return id === guild.ownerID ||
    hasPerm('administrator') ||
    MODERATOR_PERMISSIONS.some(hasPerm) ||
    hasStaffAccess(member.roles, guild) ||
    isCreator(id)
}

function safePermissionsOf (channel, memberOrId) {
  if (!channel || typeof channel.permissionsOf !== 'function' || !memberOrId) return null
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId.id || memberOrId.user?.id)
  if (!id) return null
  try {
    return channel.permissionsOf(id)
  } catch (_) {
    if (typeof memberOrId === 'object') {
      try { return channel.permissionsOf(memberOrId) } catch (__) {}
    }
    return null
  }
}

function canReadChannel (channel, memberOrId) {
  const perms = safePermissionsOf(channel, memberOrId)
  if (!perms) return false
  const has = p => (typeof perms.has === 'function' ? Boolean(perms.has(p)) : Boolean(perms.json?.[p]))
  if (!has('viewChannel') || !has('readMessageHistory')) return false
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId?.id || memberOrId?.user?.id)
  if (channel?.type === 12 && id !== global.bot?.user?.id && !has('manageThreads')) {
    return Boolean(channel.members?.has?.(id))
  }
  return true
}

function isWickPresent (guild) {
  if (!guild?.members) return false
  if (guild.members.get?.(WICK_BOT_ID)) return true
  if (typeof guild.members.values === 'function') {
    for (const m of guild.members.values()) {
      if (m?.id === WICK_BOT_ID || (m?.bot && WICK_NAME_PATTERN.test(m.username || ''))) return true
    }
  }
  return false
}

function isWickMessage (msg) {
  if (!msg) return false
  const author = msg.author
  if (author?.id === WICK_BOT_ID) return true
  if (author?.bot && WICK_NAME_PATTERN.test(author.username || '')) return true
  if (msg.webhookID && WICK_NAME_PATTERN.test(author?.username || '')) return true
  for (const e of msg.embeds || []) {
    if (WICK_NAME_PATTERN.test(e?.footer?.text || '') || WICK_NAME_PATTERN.test(e?.author?.name || '')) {
      return Boolean(author?.bot || msg.webhookID)
    }
  }
  return false
}

function sanitizeSlashArg (value, maxLen = 200) {
  return String(value || '')
    .replace(/[`\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

// Verified Wick Bot V5 slash command formatter (docs.wickbot.com).
function formatWickSlashCommand (action, params = {}) {
  const act = String(action || '').toLowerCase()
  const user = sanitizeSlashArg(params.user, 40)
  const reason = sanitizeSlashArg(params.reason, 200)
  const duration = sanitizeSlashArg(params.duration, 40)
  const proof = sanitizeSlashArg(params.proof, 300)
  const msg = sanitizeSlashArg(params.msg, 300)
  const parts = []
  const pushOpt = (k, v) => {
    if (v !== undefined && v !== null && v !== '') parts.push(`${k}:${v}`)
  }

  switch (act) {
    case 'ban':
      parts.push('/ban add')
      pushOpt('user', user)
      pushOpt('reason', reason)
      pushOpt('duration', duration)
      if (params.purge_days !== undefined && params.purge_days !== null && params.purge_days !== '') {
        const days = Math.max(0, Math.min(7, parseInt(params.purge_days, 10) || 0))
        pushOpt('purge_days', days)
      }
      if (params.soft === true) pushOpt('soft', 'true')
      if (params.hack === true) pushOpt('hack', 'true')
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'unban':
      parts.push('/ban remove')
      pushOpt('user', user)
      pushOpt('reason', reason)
      return parts.join(' ')
    case 'timeout':
    case 'mute':
      parts.push('/timeout add')
      pushOpt('user', user)
      pushOpt('duration', duration)
      pushOpt('reason', reason)
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'untimeout':
    case 'unmute':
      parts.push('/timeout remove')
      pushOpt('user', user)
      pushOpt('reason', reason)
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'kick':
      parts.push('/kick')
      pushOpt('user', user)
      pushOpt('reason', reason)
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'warn':
      parts.push('/warn')
      pushOpt('user', user)
      pushOpt('reason', reason || 'ルール違反')
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'quarantine':
      parts.push('/quarantine add')
      pushOpt('user', user)
      pushOpt('reason', reason)
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'unquarantine':
      parts.push('/quarantine remove')
      pushOpt('user', user)
      pushOpt('reason', reason)
      if (typeof params.dm === 'boolean') pushOpt('dm', String(params.dm))
      pushOpt('proof', proof)
      return parts.join(' ')
    case 'cases':
      parts.push('/cases view')
      pushOpt('user', user)
      pushOpt('type', sanitizeSlashArg(params.type, 30))
      pushOpt('mod', sanitizeSlashArg(params.mod, 40))
      return parts.join(' ')
    case 'notes':
      parts.push('/notes add')
      pushOpt('user', user)
      pushOpt('msg', msg)
      return parts.join(' ')
    case 'purge':
      parts.push('/purge')
      pushOpt('number', Math.max(1, Math.min(1000, parseInt(params.number, 10) || 10)))
      pushOpt('type', sanitizeSlashArg(params.type, 30))
      pushOpt('target', sanitizeSlashArg(params.target, 40))
      pushOpt('input', sanitizeSlashArg(params.input, 100))
      return parts.join(' ')
    case 'sanitize':
      parts.push('/sanitize')
      pushOpt('user', user)
      return parts.join(' ')
    default:
      return ''
  }
}

function buildWickTemplatesForUser (userID, { inServer = true } = {}) {
  const id = sanitizeSlashArg(userID, 40)
  if (!id) return []
  return [
    `- ケース履歴確認: \`${formatWickSlashCommand('cases', { user: id })}\``,
    `- 警告 (Warn): \`${formatWickSlashCommand('warn', { user: id, reason: '<違反ルール・理由>' })}\``,
    `- タイムアウト: \`${formatWickSlashCommand('timeout', { user: id, duration: '1h', reason: '<違反ルール・理由>' })}\`（期間は例: 10m / 1h / 1d / 7d。解除: \`${formatWickSlashCommand('untimeout', { user: id })}\`）`,
    `- キック: \`${formatWickSlashCommand('kick', { user: id, reason: '<違反ルール・理由>' })}\``,
    `- 隔離 (Quarantine): \`${formatWickSlashCommand('quarantine', { user: id, reason: '<違反ルール・理由>' })}\`（解除: \`${formatWickSlashCommand('unquarantine', { user: id })}\`）`,
    `- BAN: \`${formatWickSlashCommand('ban', { user: id, reason: '<違反ルール・理由>', ...(inServer ? {} : { hack: true }) })}\`（任意: \`duration:7d\` \`purge_days:1\` \`soft:true\` \`hack:true\` \`dm:true\` \`proof:<URL>\`。解除: \`${formatWickSlashCommand('unban', { user: id })}\`）`,
    `- モデレーターメモ: \`${formatWickSlashCommand('notes', { user: id, msg: '<メモ内容>' })}\``
  ]
}

const ACTION_MATCHERS = [
  { regex: /\bunban(?:ned)?\b|ban\s*remove|ban解除/i, action: 'Unban' },
  { regex: /\bsoft\s*ban(?:ned)?\b/i, action: 'Softban' },
  { regex: /\btemp\s*ban(?:ned)?\b/i, action: 'Tempban' },
  { regex: /\bhack\s*ban(?:ned)?\b/i, action: 'Ban' },
  { regex: /\bban(?:ned|ning)?\b|(?<![a-z])ban(?![a-z])/i, action: 'Ban' },
  { regex: /\bunquarantine[d]?\b|quarantine\s*remove|隔離解除/i, action: 'Unquarantine' },
  { regex: /\bquarantine[d]?\b|隔離/i, action: 'Quarantine' },
  { regex: /\buntimeout|deltimeout|unmute[d]?|timeout\s*remove|タイムアウト解除/i, action: 'Untimeout' },
  { regex: /\btimeout|timed\s*out|\bmute[d]?\b|タイムアウト/i, action: 'Timeout' },
  { regex: /\bkick(?:ed)?\b|キック/i, action: 'Kick' },
  { regex: /\bwarn(?:ed|ing)?\b|警告/i, action: 'Warn' },
  { regex: /\bauto\s*mod\b|\bheat\b|anti[- ]?(?:spam|raid|nuke)/i, action: 'AutoMod' },
  { regex: /\bpurge[d]?\b/i, action: 'Purge' },
  { regex: /\bnotes?\b/i, action: 'Note' }
]

function detectWickAction (text) {
  const s = String(text || '')
  for (const { regex, action } of ACTION_MATCHERS) {
    if (regex.test(s)) return action
  }
  return null
}

function extractSnowflakes (text) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(/\b(\d{17,20})\b/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

const TARGET_FIELD_RE = /^(?:user|target|member|offender|punished|victim|account|対象|ユーザー|メンバー)/i
const MOD_FIELD_RE = /^(?:mod(?:erator)?|responsible|staff|executor|issuer|by|admin|実行者|モデレーター)/i
const REASON_FIELD_RE = /^(?:reason|details?|violation|理由)/i
const DURATION_FIELD_RE = /^(?:duration|length|time|expires?|期間)/i
const CASE_FIELD_RE = /^(?:case(?:\s*(?:id|#|number))?|ケース)/i

// Parses a Wick Bot message/embed into a structured moderation log entry, or null if not a
// recognizable moderation/case/automod message.
function parseWickLogMessage (msg, { channelID = null } = {}) {
  if (!isWickMessage(msg)) return null
  const embeds = Array.isArray(msg.embeds) ? msg.embeds : []
  const content = String(msg.content || '').trim()

  const headerParts = []
  const allParts = [content]
  const targetIDs = new Set()
  const moderatorIDs = new Set()
  let moderatorLabel = null
  let reason = null
  let duration = null
  let caseID = null

  for (const e of embeds) {
    if (e?.title) {
      headerParts.push(e.title)
      allParts.push(e.title)
    }
    if (e?.author?.name) {
      headerParts.push(e.author.name)
      allParts.push(e.author.name)
    }
    if (e?.description) allParts.push(e.description)
    if (e?.footer?.text) allParts.push(e.footer.text)

    for (const f of e?.fields || []) {
      const fname = String(f?.name || '').trim()
      const fval = String(f?.value || '').trim()
      if (!fname && !fval) continue
      allParts.push(`${fname}: ${fval}`)
      if (TARGET_FIELD_RE.test(fname)) {
        for (const id of extractSnowflakes(fval)) targetIDs.add(id)
      } else if (MOD_FIELD_RE.test(fname)) {
        for (const id of extractSnowflakes(fval)) moderatorIDs.add(id)
        if (!moderatorLabel) moderatorLabel = fval.replace(/\s+/g, ' ').slice(0, 80)
      } else if (REASON_FIELD_RE.test(fname) && !reason) {
        reason = fval.replace(/\s+/g, ' ').slice(0, 250)
      } else if (DURATION_FIELD_RE.test(fname) && !duration) {
        duration = fval.replace(/\s+/g, ' ').slice(0, 60)
      } else if (CASE_FIELD_RE.test(fname) && !caseID) {
        const cm = fval.match(/#?([A-Za-z0-9_-]{1,16})/)
        if (cm) caseID = cm[1]
      }
    }

    // Inline patterns inside description / footer (common in Wick V4/V5 compact log embeds)
    const desc = String(e?.description || '')
    for (const line of desc.split(/\r?\n/)) {
      const cleanLine = line.replace(/[*_`~]/g, '').trim()
      if (/^(?:user|target|member|offender|対象)\s*[:：]/i.test(cleanLine)) {
        for (const id of extractSnowflakes(cleanLine)) targetIDs.add(id)
      } else if (/^(?:mod(?:erator)?|responsible|staff|by|実行者)\s*[:：]/i.test(cleanLine)) {
        for (const id of extractSnowflakes(cleanLine)) moderatorIDs.add(id)
        if (!moderatorLabel) moderatorLabel = cleanLine.replace(/^[^:：]+[:：]\s*/, '').slice(0, 80)
      } else if (!reason && /^(?:reason|理由)\s*[:：]/i.test(cleanLine)) {
        reason = cleanLine.replace(/^[^:：]+[:：]\s*/, '').slice(0, 250)
      } else if (!duration && /^(?:duration|length|期間)\s*[:：]/i.test(cleanLine)) {
        duration = cleanLine.replace(/^[^:：]+[:：]\s*/, '').slice(0, 60)
      }
    }
    const footer = String(e?.footer?.text || '')
    const footerUserMatch = footer.match(/(?:user\s*id|target\s*id|id)\s*[:：]\s*(\d{17,20})/i)
    if (footerUserMatch) targetIDs.add(footerUserMatch[1])
  }

  const fullText = allParts.filter(Boolean).join('\n')
  if (!fullText.trim()) return null

  const action = detectWickAction(headerParts.join(' ')) || detectWickAction(fullText)
  if (!caseID) {
    const cm = fullText.match(/(?:case|ケース)\s*(?:id|#)?\s*[:：#]?\s*([A-Za-z0-9_-]{1,16})/i)
    if (cm && !/^(?:is|was|for|by|the|not)$/i.test(cm[1])) caseID = cm[1]
  }
  if (!action && !caseID) return null

  // Fallback target ID detection: any snowflake in the message that isn't Wick itself or the moderator
  if (targetIDs.size === 0) {
    for (const id of extractSnowflakes(fullText)) {
      if (id !== WICK_BOT_ID && !moderatorIDs.has(id)) targetIDs.add(id)
    }
  }
  // Remove Wick's own bot ID if accidentally picked up
  targetIDs.delete(WICK_BOT_ID)

  const primaryTargetID = [...targetIDs][0] || null
  const excerpt = fullText.replace(/\s+/g, ' ').slice(0, 260)

  return {
    messageID: msg.id || null,
    channelID: channelID || msg.channel?.id || null,
    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
    action: action || 'Moderation',
    caseID: caseID || null,
    targetUserID: primaryTargetID,
    targetIDs: [...targetIDs],
    moderatorIDs: [...moderatorIDs],
    moderator: moderatorLabel,
    reason: reason || null,
    duration: duration || null,
    excerpt,
    fullText
  }
}

function entryMatchesTarget (entry, targetUserID, targetUsername = null) {
  if (!entry) return false
  if (targetUserID) {
    if (entry.targetIDs?.includes(targetUserID)) return true
    // If targetIDs were explicitly parsed for a different user, do NOT match via moderatorID or text
    if (entry.targetIDs?.length > 0) return false
    if (entry.moderatorIDs?.includes(targetUserID)) return false
    if (entry.fullText && entry.fullText.includes(targetUserID)) return true
  }
  if (targetUsername && entry.targetIDs?.length === 0) {
    const clean = String(targetUsername).trim().toLowerCase()
    if (clean.length >= 3 && entry.fullText?.toLowerCase().includes(clean)) return true
  }
  return false
}

function rememberWickLogChannel (guildID, channelID) {
  if (!guildID || !channelID) return
  if (!rememberedWickChannels.has(guildID)) rememberedWickChannels.set(guildID, new Set())
  const set = rememberedWickChannels.get(guildID)
  set.add(channelID)
  if (set.size > 20) {
    const first = set.values().next().value
    set.delete(first)
  }
}

function recordWickCaseInMemory (guildID, entry) {
  if (!guildID || !entry) return
  if (!recentWickCases.has(guildID)) recentWickCases.set(guildID, [])
  const list = recentWickCases.get(guildID)
  if (entry.messageID && list.some(e => e.messageID === entry.messageID)) return
  list.unshift(entry)
  if (list.length > MAX_WICK_CASES_PER_GUILD) list.length = MAX_WICK_CASES_PER_GUILD
}

// Real-time Wick Bot integration hook (called from messageCreate when Wick posts a log embed).
// Remembers the guild's Wick log channel, caches the case, and syncs Quarantine/Timeout/Kick/Ban
// actions into member_activity_profiles when alt-detection is enabled.
async function onWickMessage (message) {
  const guild = message?.channel?.guild
  if (!guild?.id || !isWickMessage(message)) return null
  const parsed = parseWickLogMessage(message, { channelID: message.channel.id })
  if (!parsed) return null

  rememberWickLogChannel(guild.id, message.channel.id)
  recordWickCaseInMemory(guild.id, parsed)

  if (parsed.targetUserID && ['Ban', 'Tempban', 'Softban', 'Kick', 'Quarantine', 'Timeout'].includes(parsed.action)) {
    const statusMap = {
      Ban: 'banned',
      Tempban: 'banned',
      Softban: 'kicked',
      Kick: 'kicked',
      Quarantine: 'restricted',
      Timeout: 'restricted'
    }
    const nextStatus = statusMap[parsed.action]
    try {
      const enabled = await altDB.isAltDetectionEnabled(guild.id)
      if (enabled) {
        const existing = await altDB.getMemberProfile(guild.id, parsed.targetUserID)
        // Do not downgrade an existing banned/kicked status to restricted
        const rank = { active: 0, left: 1, restricted: 2, kicked: 3, banned: 4 }
        const currentRank = rank[existing?.status] ?? 0
        const nextRank = rank[nextStatus] ?? 0
        const finalStatus = nextRank >= currentRank ? nextStatus : existing.status
        const caseTag = parsed.caseID ? ` #${parsed.caseID}` : ''
        const reason = `[Wick ${parsed.action}${caseTag}] ${parsed.reason || '理由未記載'}`.slice(0, 280)
        const member = guild.members?.get?.(parsed.targetUserID)
        await altDB.markMemberStatus(guild.id, parsed.targetUserID, finalStatus, {
          reason,
          at: parsed.timestamp,
          profile: member
            ? {
                username: member.username || member.user?.username || null,
                globalName: member.user?.globalName || member.globalName || null,
                nick: member.nick || null,
                accountCreatedAt: snowflakeToDate(parsed.targetUserID),
                joinedAt: member.joinedAt ? new Date(member.joinedAt) : null
              }
            : { accountCreatedAt: snowflakeToDate(parsed.targetUserID) }
        })
      }
    } catch (_) {
      // Non-fatal: DB may be unavailable in tests or unconfigured guilds
    }
  }
  return parsed
}

function candidateWickLogChannels (guild) {
  if (!guild?.channels) return []
  const botID = global.bot?.user?.id
  const all = [...guild.channels.values()].filter(c => c && (c.type === 0 || c.type === 5) && (!botID || canReadChannel(c, botID)))
  const remembered = rememberedWickChannels.get(guild.id) || new Set()
  const guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  const configuredLogIDs = new Set(Object.values(guildSettings?.event_logs || {}).filter(Boolean))
  const modSettingIDs = new Set([guild.publicUpdatesChannelID, guild.safetyAlertsChannelID].filter(Boolean))

  const scored = all.map(c => {
    let priority = 0
    if (remembered.has(c.id)) priority += 100
    if (/wick/i.test(c.name || '')) priority += 80
    if (/mod[-_]?log|punish|処罰|処置|case/i.test(c.name || '')) priority += 60
    if (WICK_LOG_CHANNEL_PATTERN.test(c.name || '')) priority += 30
    if (configuredLogIDs.has(c.id)) priority += 25
    if (modSettingIDs.has(c.id)) priority += 20
    return { channel: c, priority }
  }).filter(x => x.priority > 0)

  scored.sort((a, b) => b.priority - a.priority)
  return scored.slice(0, MAX_WICK_LOG_CHANNELS).map(x => x.channel)
}

async function fetchWickModLogs (guild, targetUserID, { targetUsername = null, perChannel = MAX_WICK_MESSAGES_PER_CHANNEL, maxChannels = MAX_WICK_LOG_CHANNELS } = {}) {
  const wickPresent = isWickPresent(guild)
  const byMsgID = new Map()

  for (const cached of recentWickCases.get(guild?.id) || []) {
    if (entryMatchesTarget(cached, targetUserID, targetUsername)) {
      byMsgID.set(cached.messageID || `${cached.timestamp?.getTime()}:${cached.action}:${cached.caseID}`, cached)
    }
  }

  const channels = candidateWickLogChannels(guild).slice(0, maxChannels)
  const scannedChannels = []
  let wickLogsSeen = (recentWickCases.get(guild?.id)?.length || 0) > 0

  for (const ch of channels) {
    if (typeof global.bot?.getMessages !== 'function') break
    const msgs = await global.bot.getMessages(ch.id, { limit: perChannel }).catch(() => null)
    if (!Array.isArray(msgs)) continue
    scannedChannels.push({ id: ch.id, name: ch.name })
    for (const m of msgs) {
      if (!isWickMessage(m)) continue
      const parsed = parseWickLogMessage(m, { channelID: ch.id })
      if (!parsed) continue
      wickLogsSeen = true
      rememberWickLogChannel(guild.id, ch.id)
      recordWickCaseInMemory(guild.id, parsed)
      if (entryMatchesTarget(parsed, targetUserID, targetUsername)) {
        const key = parsed.messageID || `${parsed.timestamp?.getTime()}:${parsed.action}:${parsed.caseID}`
        if (!byMsgID.has(key)) byMsgID.set(key, parsed)
      }
    }
  }

  const entries = [...byMsgID.values()].sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0))
  return { wickPresent, wickLogsSeen, scannedChannels, entries }
}

function formatMessageTextForRules (m) {
  const parts = []
  const content = String(m?.content || '').trim()
  if (content && !isUnsafeMinorContent(content)) parts.push(content)
  for (const e of m?.embeds || []) {
    const eParts = [
      e.title,
      e.description,
      ...(e.fields || []).map(f => `${f.name || ''}${f.name && f.value ? ': ' : ''}${f.value || ''}`)
    ].filter(Boolean)
    const eText = eParts.join('\n').trim()
    if (eText && !isUnsafeMinorContent(eText)) parts.push(eText)
  }
  return parts.join('\n').trim()
}

async function fetchServerRules (guild, { requester = null, forceRefresh = false } = {}) {
  if (!guild?.id) return { channels: [], text: '', truncated: false }
  const botID = global.bot?.user?.id
  const requesterIsMod = requester ? isModerator(requester, guild) : true
  const readableByAll = ch => {
    if (!ch || (ch.type !== 0 && ch.type !== 5)) return false
    if (botID && !canReadChannel(ch, botID)) return false
    if (requester && !requesterIsMod && !canReadChannel(ch, requester)) return false
    return true
  }

  const cacheKey = `${guild.id}:${requesterIsMod ? 'mod' : (requester?.id || 'anon')}`
  const cached = !forceRefresh ? rulesCache.get(cacheKey) : null
  if (cached && cached.expiresAt > Date.now()) {
    return { channels: cached.channels, text: cached.text, truncated: cached.truncated }
  }

  const candidates = []
  const seen = new Set()
  const addCandidate = ch => {
    if (ch && !seen.has(ch.id) && readableByAll(ch)) {
      seen.add(ch.id)
      candidates.push(ch)
    }
  }

  if (guild.rulesChannelID) {
    addCandidate(guild.channels?.get?.(guild.rulesChannelID) || global.bot?.getChannel?.(guild.rulesChannelID))
  }
  for (const ch of guild.channels?.values?.() || []) {
    if (RULES_CHANNEL_PATTERN.test(ch.name || '')) addCandidate(ch)
  }

  const channels = []
  const sections = []
  for (const ch of candidates.slice(0, 3)) {
    if (typeof global.bot?.getMessages !== 'function') break
    const msgs = await global.bot.getMessages(ch.id, { limit: 20 }).catch(() => null)
    if (!Array.isArray(msgs) || msgs.length === 0) continue
    const ordered = [...msgs].reverse()
    const blocks = ordered.map(formatMessageTextForRules).filter(Boolean)
    if (!blocks.length) continue
    channels.push({ id: ch.id, name: ch.name })
    sections.push(`### <#${ch.id}> (#${ch.name})\n${blocks.join('\n\n')}`)
    // If official guild.rulesChannelID yielded rules, avoid pulling unrelated noisy channels
    if (guild.rulesChannelID && ch.id === guild.rulesChannelID) break
  }

  const rawText = sections.join('\n\n')
  const truncated = rawText.length > MAX_RULES_CHARS
  const text = truncated ? `${rawText.slice(0, MAX_RULES_CHARS)}\n…（長いため省略）` : rawText

  rulesCache.set(cacheKey, { channels, text, truncated, expiresAt: Date.now() + RULES_CACHE_TTL_MS })
  return { channels, text, truncated }
}

const AUDIT_ACTION_LABELS = {
  20: 'キック (Kick)',
  22: 'BAN',
  23: 'BAN解除 (Unban)',
  24: 'メンバー更新 (Timeout等)',
  25: 'ロール変更',
  72: 'モデレーターによるメッセージ削除'
}

async function fetchAuditModerationHistory (guild, targetUserID, { limit = 50 } = {}) {
  const entries = []
  let auditReadable = false
  let currentBan = null

  if (guild && targetUserID && typeof guild.getAuditLog === 'function') {
    const log = await guild.getAuditLog({ limit }).catch(() => null)
    if (log && Array.isArray(log.entries)) {
      auditReadable = true
      for (const e of log.entries) {
        if (!e || e.targetID !== targetUserID) continue
        if (!AUDIT_ACTION_LABELS[e.actionType]) continue
        if (e.actionType === 24) {
          const timeoutChange = (e.before?.communication_disabled_until !== undefined || e.after?.communication_disabled_until !== undefined) ||
            (Array.isArray(e.changes) && e.changes.some(c => c.key === 'communication_disabled_until'))
          if (!timeoutChange) continue
        }
        const actorID = e.user?.id || null
        const isWick = actorID === WICK_BOT_ID || (e.user?.bot && WICK_NAME_PATTERN.test(e.user?.username || ''))
        const actorLabel = isWick
          ? 'Wick Bot'
          : (e.user?.username ? `${e.user.username} (${actorID})` : (actorID || '不明'))
        let detail = AUDIT_ACTION_LABELS[e.actionType]
        if (e.actionType === 24) {
          const until = e.after?.communication_disabled_until || e.changes?.find?.(c => c.key === 'communication_disabled_until')?.new_value
          detail = until ? `タイムアウト設定（期限: ${formatJstDate(until) || until}）` : 'タイムアウト解除'
        } else if (e.actionType === 72 && e.count) {
          detail = `モデレーターによるメッセージ削除（${e.count}件）`
        }
        entries.push({
          id: e.id,
          actionType: e.actionType,
          action: detail,
          actorID,
          actorLabel,
          isWick,
          reason: e.reason || null,
          timestamp: snowflakeToDate(e.id) || new Date()
        })
      }
    }
  }

  if (guild?.id && targetUserID && typeof global.bot?.requestHandler?.request === 'function') {
    const ban = await global.bot.requestHandler.request('GET', `/guilds/${guild.id}/bans/${targetUserID}`, true).catch(() => null)
    if (ban && (ban.user || ban.reason !== undefined)) {
      currentBan = { reason: ban.reason || null, user: ban.user || null }
    }
  }

  return { auditReadable, entries, currentBan }
}

function offenderRoleIds () {
  const raw = String(process.env.ALT_OFFENDER_ROLE_IDS || '').trim()
  if (!raw) return DEFAULT_OFFENDER_ROLE_IDS
  return raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
}

function resolveMemberTarget (guild, who, storedProfiles = []) {
  const text = String(who || '').trim()
  const idMatch = text.match(/^<@!?(\d{15,22})>$/)?.[1] || (/^\d{15,22}$/.test(text) ? text : null)
  if (idMatch) {
    const live = guild?.members?.get?.(idMatch) || null
    const stored = storedProfiles.find(p => p.userID === idMatch) || null
    return { matches: [{ userID: idMatch, member: live, stored }] }
  }
  const q = text.replace(/^@/, '').toLowerCase()
  if (!q) return { matches: [] }

  const byID = new Map()
  for (const m of guild?.members?.values?.() || []) {
    const names = [m.nick, m.user?.globalName, m.globalName, m.username].filter(Boolean).map(n => n.toLowerCase())
    const exact = names.includes(q)
    const partial = !exact && names.some(n => n.includes(q))
    if (exact || partial) byID.set(m.id, { userID: m.id, member: m, stored: null, exact })
  }
  for (const p of storedProfiles || []) {
    if (!p?.userID) continue
    const names = [p.nick, p.globalName, p.username].filter(Boolean).map(n => n.toLowerCase())
    const exact = names.includes(q)
    const partial = !exact && names.some(n => n.includes(q))
    if (exact || partial) {
      const prev = byID.get(p.userID)
      if (prev) prev.stored = p
      else byID.set(p.userID, { userID: p.userID, member: null, stored: p, exact })
    }
  }
  const all = [...byID.values()]
  const exactMatches = all.filter(x => x.exact)
  return { matches: exactMatches.length ? exactMatches : all }
}

const STATUS_LABELS = {
  active: '在籍中',
  left: '退室済み',
  restricted: '要注意 / 制限ロール付与歴あり',
  kicked: 'キック歴あり',
  banned: 'BAN歴あり'
}

// Builds a comprehensive moderation dossier for moderators asking about a member/troll or
// requesting a Wick Bot punishment command.
async function buildModerationDossier (guild, who) {
  let candidateProfiles = []
  try {
    candidateProfiles = await altDB.getCandidateProfiles(guild.id, '', { limit: 200 })
  } catch (_) {}

  const { matches } = resolveMemberTarget(guild, who, candidateProfiles)
  if (matches.length === 0) {
    throw new Error(`「${who}」に当てはまるユーザーが見つかりません（ID またはメンション <@ID> で指定すると退室・BAN済みのユーザーも調べられます）`)
  }
  if (matches.length > 1) {
    const list = matches.slice(0, 5).map(x => {
      const name = x.member
        ? (x.member.nick || x.member.user?.globalName || x.member.username)
        : (x.stored?.nick || x.stored?.globalName || x.stored?.username || x.userID)
      const uname = x.member?.username || x.stored?.username || '不明'
      return `- ${name}（@${uname}、ID: ${x.userID}${x.member ? '' : '、現在サーバー不在'}）`
    }).join('\n')
    return `「${who}」に当てはまるユーザーが複数います。どの人か確認してください:\n${list}`
  }

  const target = matches[0]
  const userID = target.userID
  const liveMember = target.member || guild?.members?.get?.(userID) || null
  let profile = target.stored || null
  if (!profile) {
    try { profile = await altDB.getMemberProfile(guild.id, userID) } catch (_) {}
  }

  const targetUsername = liveMember?.username || liveMember?.user?.username || profile?.username || null

  const crossServerBan = require('./crossServerBan')
  const altDetector = require('./altDetector')
  const [wickResult, auditResult, dbMessages, recentAlerts, otherGuildBans, crossSimilarBans] = await Promise.all([
    fetchWickModLogs(guild, userID, { targetUsername }).catch(() => ({ wickPresent: isWickPresent(guild), wickLogsSeen: false, scannedChannels: [], entries: [] })),
    fetchAuditModerationHistory(guild, userID).catch(() => ({ auditReadable: false, entries: [], currentBan: null })),
    altDB.getMemberMessages(guild.id, userID, { limit: 25, includeDeleted: true }).catch(() => []),
    altDB.getRecentAlerts(guild.id, { limit: 30 }).catch(() => []),
    crossServerBan.findOtherGuildBans(userID, guild.id, { includeLiveCheck: true }).catch(() => []),
    altDetector.findCrossGuildSimilarBans(guild, userID, { minScore: 35, limit: 3 }).catch(() => [])
  ])

  const relatedAlerts = (recentAlerts || []).filter(a => a.suspectUserID === userID || a.candidateUserID === userID).slice(0, 5)
  const safeMessages = (dbMessages || []).filter(m => m?.content && !isUnsafeMinorContent(m.content))
  const deletedByModCount = safeMessages.filter(m => m.deleted && m.deletedBy === 'moderator').length
  const deletedBySelfCount = safeMessages.filter(m => m.deleted && m.deletedBy === 'self').length

  const displayName = liveMember
    ? (liveMember.nick || liveMember.user?.globalName || liveMember.globalName || liveMember.username)
    : (profile?.nick || profile?.globalName || profile?.username || auditResult.currentBan?.user?.username || userID)
  const roles = liveMember
    ? (liveMember.roles || []).map(id => guild.roles?.get?.(id)).filter(r => r && !r.managed).sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map(r => r.name)
    : []
  const offenderIds = offenderRoleIds()
  const hasOffenderRole = Boolean(liveMember?.roles?.some(id => offenderIds.includes(id)))
  const createdAt = snowflakeToDate(userID) || profile?.accountCreatedAt || null
  const joinedAt = liveMember?.joinedAt ? new Date(liveMember.joinedAt) : (profile?.joinedAt || null)
  const timeoutUntil = liveMember?.communicationDisabledUntil ? new Date(liveMember.communicationDisabledUntil) : null
  const isTimedOutNow = Boolean(timeoutUntil && timeoutUntil.getTime() > Date.now())

  const lines = [
    '## 対象ユーザー情報',
    `- 表示名: ${displayName}${targetUsername ? `（@${targetUsername}）` : ''} / ユーザーID: \`${userID}\``,
    `- サーバー在籍状況: ${liveMember ? '在籍中' : (auditResult.currentBan ? '現在BAN中' : 'サーバー不在（退室または処罰済み）')}`,
    createdAt ? `- アカウント作成日: ${formatJstDate(createdAt)}` : '',
    joinedAt ? `- サーバー参加日: ${formatJstDate(joinedAt)}` : '',
    liveMember ? `- 現在のロール: ${roles.join(', ') || 'なし'}` : '',
    hasOffenderRole ? '- ⚠️ 要注意・制限ロールが付与されています' : '',
    isTimedOutNow ? `- 🔇 現在タイムアウト中（解除予定: ${formatJstDate(timeoutUntil)}）` : '',
    auditResult.currentBan ? `- 🔨 現在サーバーBAN中（BAN理由: ${auditResult.currentBan.reason || '理由未記載'}）` : '',
    otherGuildBans.length ? `- 🚨 他サーバーでBANされています（${otherGuildBans.length}件）` : '',
    crossSimilarBans.length ? `- ⚠️ 他サーバーでBANされたユーザーとの類似候補あり（${crossSimilarBans.length}件、最高スコア ${crossSimilarBans[0].heuristic.score}/100）` : '',
    profile ? `- RoboPolice DB 記録ステータス: ${STATUS_LABELS[profile.status] || profile.status}${profile.statusAt ? `（${formatJstDate(profile.statusAt)}）` : ''}${profile.moderationReason ? ` / 理由: ${profile.moderationReason}` : ''}` : ''
  ].filter(Boolean)

  // Cross-server BAN records
  lines.push('', '## 他サーバーでのBAN履歴（BOT導入済みサーバー横断照合）')
  if (otherGuildBans.length > 0) {
    for (const b of otherGuildBans.slice(0, 10)) {
      const label = b.guildName && b.guildName !== b.guildID ? `${b.guildName} (${b.guildID})` : b.guildID
      const src = b.source === 'live' ? 'リアルタイム確認' : 'BOT記録'
      lines.push(`- 🚨 ${label} [${src}]${b.bannedAt ? ` / ${formatJstDate(b.bannedAt)}` : ''} / 理由: ${b.reason || '記載なし'}`)
    }
  } else {
    lines.push('- BOT導入済みの他サーバーでの本人IDのBAN履歴は見つかりませんでした')
  }
  if (crossSimilarBans.length > 0) {
    lines.push('', '## 他サーバーBAN者との類似候補（別アカウント・サブ垢の疑い）')
    for (const item of crossSimilarBans) {
      const p = item.candidateProfile
      const gLabel = p.guildName && p.guildName !== p.guildID ? `${p.guildName} (${p.guildID})` : (p.guildID || '他サーバー')
      const sigs = item.heuristic.signals.slice(0, 3).join(' / ')
      lines.push(`- ⚠️ 候補: ${p.username || '不明'} (${p.userID}) — 他サーバー「${gLabel}」でBAN済み${p.moderationReason ? `（理由: ${p.moderationReason}）` : ''} / 類似スコア: ${item.heuristic.score}/100${sigs ? ` / 根拠: ${sigs}` : ''}`)
    }
  }

  // Wick Bot modlogs
  lines.push('', '## Wick Bot 処罰・ケース履歴（サーバー内ログチャンネルより取得）')
  lines.push(`- Wick Bot 導入状況: ${wickResult.wickPresent ? 'サーバーに導入済み' : 'メンバー一覧では未確認'}${wickResult.scannedChannels.length ? `（確認チャンネル: ${wickResult.scannedChannels.map(c => `#${c.name}`).join(', ')}）` : ''}`)
  if (wickResult.entries.length > 0) {
    for (const e of wickResult.entries.slice(0, 15)) {
      const parts = [
        `[${formatJstDate(e.timestamp) || '?'}]`,
        e.action,
        e.caseID ? `Case #${e.caseID}` : '',
        e.duration ? `期間: ${e.duration}` : '',
        e.reason ? `理由: ${e.reason}` : '',
        e.moderator ? `実行: ${e.moderator}` : ''
      ].filter(Boolean)
      lines.push(`- ${parts.join(' / ')}`)
    }
  } else {
    lines.push(wickResult.wickLogsSeen
      ? '- Wick ログチャンネル内に対象ユーザーの処罰履歴は見つかりませんでした（直近のログ範囲）'
      : '- Wick のログチャンネルに対象ユーザーの履歴が見つかりませんでした（Wick 側の全ケース確認は `/cases view user:' + userID + '` で確認できます）')
  }

  // Discord Audit Logs
  lines.push('', '## Discord 監査ログ上の処罰・削除履歴')
  if (!auditResult.auditReadable) {
    lines.push('- 監査ログを取得できませんでした（BOT に監査ログ閲覧権限がない可能性があります）')
  } else if (auditResult.entries.length === 0) {
    lines.push('- 直近の監査ログに対象ユーザーへの処罰・モデレーター削除記録はありません')
  } else {
    for (const e of auditResult.entries.slice(0, 10)) {
      lines.push(`- [${formatJstDate(e.timestamp) || '?'}] ${e.action}（実行: ${e.actorLabel}${e.reason ? ` / 理由: ${e.reason}` : ''}）`)
    }
  }

  // Alt-account alerts
  if (relatedAlerts.length > 0) {
    lines.push('', '## サブ垢・BAN回避検知アラート履歴（RoboPolice）')
    for (const a of relatedAlerts) {
      const otherID = a.suspectUserID === userID ? a.candidateUserID : a.suspectUserID
      const otherName = a.suspectUserID === userID ? (a.candidateUsername || otherID) : (a.suspectUsername || otherID)
      const conf = a.aiConfidence != null ? `AI確信度 ${a.aiConfidence}%` : `スコア ${a.heuristicScore}/100`
      lines.push(`- [${formatJstDate(a.createdAt) || '?'}] 判定: ${a.verdict}（${conf}）/ 候補: ${otherName} (${otherID}${a.candidateStatus ? `, ${a.candidateStatus}` : ''})${a.summary ? ` — ${a.summary.slice(0, 140)}` : ''}`)
    }
  }

  // Recent messages including mod-deleted & self-deleted snapshots
  lines.push('', '## 最近の発言履歴（モデレーター削除・本人削除・編集前スナップショットを含む）')
  if (deletedByModCount > 0 || deletedBySelfCount > 0) {
    lines.push(`- 削除記録サマリ: モデレーター削除 ${deletedByModCount} 件 / 本人削除 ${deletedBySelfCount} 件`)
  }
  if (safeMessages.length === 0) {
    lines.push('- DB に保存されている発言履歴はありません（必要なら get_recent_messages 等でチャンネルを確認してください）')
  } else {
    for (const m of safeMessages.slice(0, 20)) {
      const chName = guild.channels?.get?.(m.channelID)?.name || m.channelID || '不明'
      let tag = ''
      if (m.deleted) {
        if (m.deletedBy === 'moderator') tag = '[モデレーター削除済み] '
        else if (m.deletedBy === 'self') tag = '[本人削除済み] '
        else tag = '[削除済み] '
      } else if (m.editedBefore) {
        tag = '[編集前] '
      }
      const text = m.content.replace(/\s+/g, ' ').slice(0, 200)
      lines.push(`- [${formatJstDate(m.ts) || '?'}] #${chName} ${tag}${text}`)
    }
  }

  // Copy-pasteable Wick V5 slash command reference for this exact target
  lines.push(
    '',
    '## コピペ用 Wick Bot V5 スラッシュコマンド雛形（docs.wickbot.com 準拠）',
    ...buildWickTemplatesForUser(userID, { inServer: Boolean(liveMember) }),
    '※ Discord API の制約上、RoboPolice から Wick のスラッシュコマンドを直接実行することはできないため、提案時は上記の正確な書式で `<違反ルール・理由>` を埋めたコピペ用コマンドをコードブロックで提示すること。'
  )

  return lines.join('\n')
}

module.exports = {
  WICK_BOT_ID,
  MODERATOR_PERMISSIONS,
  resetRuntimeState,
  snowflakeToDate,
  isModerator,
  isWickPresent,
  isWickMessage,
  formatWickSlashCommand,
  buildWickTemplatesForUser,
  detectWickAction,
  parseWickLogMessage,
  entryMatchesTarget,
  onWickMessage,
  fetchWickModLogs,
  fetchServerRules,
  fetchAuditModerationHistory,
  resolveMemberTarget,
  buildModerationDossier
}
