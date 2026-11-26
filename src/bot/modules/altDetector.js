// Hybrid 2-stage AI alt-account (サブ垢) detection:
//   Stage 1 (deterministic, zero AI cost): account age, BAN/kick/leave timing proximity, invite
//     code match, custom avatar hash match, username/display-name similarity, Japanese/Discord
//     stylometry, character 3-grams, active-hours histogram, channel overlap, optional pgvector
//     embedding centroid, and simultaneous-message anti-false-positive penalty.
//   Stage 2 (Gemini precision verification): only invoked for suspicious candidates exceeding
//     Stage 1 thresholds (or manual /altcheck). Multimodal (optional avatar visual comparison)
//     with prompt-injection defense (<untrusted>) and structured JSON verdict.
// Alert-only to the server's staff log channel: never kicks, bans, or mutes automatically.
const zlib = require('zlib')
const altDB = require('../../db/interfaces/postgres/altDetection')
const send = require('./webhooksender')
const cacheGuild = require('../utils/cacheGuild')
const { ALL_EVENTS, EMBED_COLORS } = require('../utils/constants')
const { callGemini, resolveTaskConfig } = require('./eventDrafter')
const { isGatewayConfigured } = require('../utils/aiGateway')
const backgroundQueue = require('../utils/backgroundQueue')
const prompts = require('../utils/prompts')
const untrusted = require('../utils/untrusted')
const urlFetcher = require('../utils/urlFetcher')

const DISCORD_EPOCH = 1420070400000
const MESSAGE_MILESTONES = [5, 15, 30]
const SLEEPER_CHECK_MILESTONES = [10, 30]
const MAX_COUNTER_ENTRIES = 10000
const SIMULTANEOUS_WINDOW_MS = 15 * 1000
const BURST_WINDOW_MS = 20 * 1000
const DEFAULT_OFFENDER_ROLE_IDS = ['882586674717138954']
const MOD_STATUSES = new Set(['banned', 'kicked', 'restricted'])
const ALERT_EVENT_PRIORITY = ['guildBanAdd', 'guildMemberKick', 'guildMemberAdd', 'guildMemberRemove', ...ALL_EVENTS]
const GENERIC_URL_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'discord.com',
  'discordapp.com',
  'tenor.com',
  'media.tenor.com',
  'giphy.com',
  'media.giphy.com',
  'imgur.com',
  'i.imgur.com'
])
const COMMON_TOKENS = new Set([
  'https', 'http', 'www', 'com', 'net', 'org', 'the', 'and', 'for', 'that', 'this',
  'with', 'from', 'you', 'are', 'not', 'lol', 'www',
  '今日', '昨日', '明日', '自分', '本当', '普通', '大丈夫', '問題', '時間', '最近',
  '一応', '結構', '全然', '多分', '最初', '最後', '意味', '理由', '確認', '参加',
  '動画', '配信', 'ゲーム', 'サーバー', 'チャンネル', 'メッセージ', 'コメント'
])
// Topic-agnostic Japanese function words, particles, discourse markers, and pronouns
// (Jin 2002 particle n-gram stylometry; Halvani TAVeer topic-agnostic feature categories).
const JAPANESE_FUNCTION_WORDS = [
  'というか', 'ていうか', 'っていう', 'だけどね', 'ですから', 'なんです', 'なんだけど',
  'だけど', 'けどさ', 'ですね', 'ですよ', 'だよね', 'やっぱ', 'ちなみ', 'そもそも',
  '個人的', 'だから', 'なので', 'しかも', 'むしろ', 'せめて', 'さすがに', 'てか',
  'なんか', 'まあ', '一応', 'マジ', '普通', 'って', 'けど', 'のに', 'から', 'まで',
  'しか', 'だけ', 'とか', 'ので', 'ため', 'だわ', 'だろ', 'じゃん', 'やん', 'かな',
  'かも', 'だよ', 'だね', 'です', 'ます', 'やろ', 'なんよ', '俺', '僕', '私', 'わい', 'ワイ'
]

const ALT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['likely_alt', 'possible_alt', 'unlikely', 'insufficient'] },
    confidence: { type: 'INTEGER' },
    summary: { type: 'STRING' },
    matching_evidence: { type: 'ARRAY', items: { type: 'STRING' } },
    counter_evidence: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['verdict', 'confidence', 'summary', 'matching_evidence', 'counter_evidence']
}

// Bounded in-memory counter so normal guild traffic never queries Postgres on every message.
// Key: `${guildID}:${userID}` -> { count: number, checked: Set<number> }
const messageCounters = new Map()
// Bounded in-memory cache of recently seen non-bot messages so deletions/edits in audit-ignored
// channels (or before messageBatcher flushes) are still captured for alt detection.
const MAX_SEEN_MESSAGES = 5000
const recentSeenMessages = new Map() // messageID -> { id, guildID, authorID, channelID, content, ts }
// Recent deleted messages per guild for real-time cross-account delete->repost detection.
const MAX_RECENT_DELETED_PER_GUILD = 100
const RECENT_DELETED_TTL_MS = 30 * 60 * 1000
const recentDeletedByGuild = new Map() // guildID -> Array<{ id, authorID, channelID, content, originalTs, deletedTs, deletedBy, moderatorID }>
// Tracks Discord MESSAGE_DELETE (actionType 72) audit log extra.count so repeat deletions by the
// same moderator of the same author in the same channel are recognized accurately.
const MAX_AUDIT_COUNT_ENTRIES = 1000
const lastModDeleteCounts = new Map() // `${guildID}:${entryID}` -> number
// Short-lived cache for REST GET /guilds/:id (to read Discord's safety_alerts_channel_id when
// Eris 0.17's Guild structure does not expose it directly).
const MOD_CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000
const guildModChannelCache = new Map() // guildID -> { publicUpdatesChannelID, safetyAlertsChannelID, expiresAt }
// Per-guild daily automatic AI call budget (prevents runaway API costs during join raids).
const autoAiDailyCounts = new Map() // guildID -> { dayKey, count }

function resetRuntimeState () {
  messageCounters.clear()
  recentSeenMessages.clear()
  recentDeletedByGuild.clear()
  lastModDeleteCounts.clear()
  guildModChannelCache.clear()
  autoAiDailyCounts.clear()
}

function rememberSeenMessage ({ id, guildID, authorID, channelID = null, content, ts = new Date() }) {
  const clean = String(content || '').trim()
  if (!id || !guildID || !authorID || !clean) return
  if (recentSeenMessages.has(id)) recentSeenMessages.delete(id)
  if (recentSeenMessages.size >= MAX_SEEN_MESSAGES) {
    const oldest = recentSeenMessages.keys().next().value
    recentSeenMessages.delete(oldest)
  }
  recentSeenMessages.set(id, {
    id,
    guildID,
    authorID,
    channelID: channelID || null,
    content: clean,
    ts: ts instanceof Date ? ts : new Date(ts)
  })
}

function rememberDeletedMessage (guildID, entry, now = new Date()) {
  if (!guildID || !entry?.authorID || !entry?.content) return null
  const cutoff = now.getTime() - RECENT_DELETED_TTL_MS
  const list = (recentDeletedByGuild.get(guildID) || []).filter(e => e.deletedTs.getTime() >= cutoff)
  const record = {
    id: entry.id || entry.messageID || null,
    authorID: entry.authorID,
    channelID: entry.channelID || null,
    content: String(entry.content).trim(),
    originalTs: entry.originalTs ? new Date(entry.originalTs) : (entry.ts ? new Date(entry.ts) : now),
    deletedTs: entry.deletedTs ? new Date(entry.deletedTs) : now,
    deletedBy: entry.deletedBy || 'unknown',
    moderatorID: entry.moderatorID || null
  }
  list.push(record)
  if (list.length > MAX_RECENT_DELETED_PER_GUILD) {
    list.splice(0, list.length - MAX_RECENT_DELETED_PER_GUILD)
  }
  recentDeletedByGuild.set(guildID, list)
  return record
}

function envNumber (name, fallback, min = 0, max = Infinity) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

function isGlobalEnabled () {
  return process.env.ALT_DETECTION !== 'false'
}

// Role IDs treated as offenders (same evasion/priority rules as banned/kicked accounts).
// Unset uses DEFAULT_OFFENDER_ROLE_IDS; set to empty string to disable.
function offenderRoleIds () {
  const raw = process.env.ALT_OFFENDER_ROLE_IDS
  if (raw === undefined) return new Set(DEFAULT_OFFENDER_ROLE_IDS)
  return new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean))
}

function hasOffenderRole (member) {
  const roles = member?.roles
  if (!Array.isArray(roles) || roles.length === 0) return false
  const ids = offenderRoleIds()
  if (ids.size === 0) return false
  return roles.some(r => ids.has(String(r)))
}

function joinAiThreshold (isModCandidate = true) {
  const base = envNumber('ALT_JOIN_AI_THRESHOLD', 45, 0, 100)
  return isModCandidate ? base : Math.min(100, base + 15)
}

function messageAiThreshold () {
  return envNumber('ALT_MESSAGE_AI_THRESHOLD', 40, 0, 100)
}

function maxDailyAutoAi () {
  return envNumber('ALT_MAX_DAILY_AUTO_AI', 30, 0, 10000)
}

function consumeAutoAiBudget (guildID, now = new Date()) {
  const limit = maxDailyAutoAi()
  if (limit === 0) return true // 0 disables the cap
  if (!guildID) return false
  const dayKey = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10)
  const cur = autoAiDailyCounts.get(guildID)
  if (!cur || cur.dayKey !== dayKey) {
    autoAiDailyCounts.set(guildID, { dayKey, count: 1 })
    return true
  }
  if (cur.count >= limit) return false
  cur.count++
  return true
}

function alertConfidence () {
  return envNumber('ALT_ALERT_CONFIDENCE', 65, 0, 100)
}

function alertCooldownHours () {
  return envNumber('ALT_ALERT_COOLDOWN_HOURS', 24, 0, 24 * 365)
}

function messageWatchDays () {
  return envNumber('ALT_MESSAGE_WATCH_DAYS', 14, 1, 365)
}

function snowflakeToDate (id) {
  if (!id || !/^\d{15,22}$/.test(String(id))) return null
  try {
    return new Date(Number(BigInt(String(id)) >> 22n) + DISCORD_EPOCH)
  } catch (_) {
    return null
  }
}

function avatarUrlOf (obj) {
  if (!obj) return null
  const u = obj.user || obj
  try {
    if (typeof u.dynamicAvatarURL === 'function') return u.dynamicAvatarURL('png', 256)
  } catch (_) {}
  return u.avatarURL || obj.avatarURL || null
}

function profileFromUser (user, extra = {}) {
  if (!user?.id) return null
  const createdAt = user.createdAt ? new Date(user.createdAt) : snowflakeToDate(user.id)
  return {
    userID: user.id,
    username: user.username || null,
    globalName: user.globalName || null,
    nick: null,
    avatarHash: user.avatar || null,
    avatarURL: avatarUrlOf(user),
    accountCreatedAt: createdAt,
    joinedAt: null,
    inviteCode: null,
    status: 'active',
    statusAt: null,
    moderationReason: null,
    ...extra
  }
}

function profileFromMember (member, extra = {}) {
  if (!member) return null
  const user = member.user || member
  const userID = member.id || user.id
  if (!userID) return null
  const createdAt = user.createdAt
    ? new Date(user.createdAt)
    : (member.createdAt ? new Date(member.createdAt) : snowflakeToDate(userID))
  const joinedAt = member.joinedAt ? new Date(member.joinedAt) : null
  const restricted = hasOffenderRole(member)
  return {
    userID,
    username: user.username || member.username || null,
    globalName: user.globalName || member.globalName || null,
    nick: member.nick || null,
    avatarHash: member.avatar || user.avatar || null,
    avatarURL: avatarUrlOf(member),
    accountCreatedAt: createdAt,
    joinedAt,
    inviteCode: null,
    status: restricted ? 'restricted' : 'active',
    statusAt: null,
    moderationReason: restricted ? '違反者ロール付与' : null,
    _hasKnownRoles: Array.isArray(member.roles),
    ...extra
  }
}

// --- Stage 1: Deterministic features & heuristic scoring ---

function normalizeName (str) {
  const nfkc = String(str || '').normalize('NFKC').toLowerCase().trim()
  const cleaned = nfkc.replace(/[\s_.\-/\\|]+/g, '')
  const stem = cleaned
    .replace(/(?:sub|alt|sab|sabu|2nd|3rd|main|サブ|裏|別垢|本垢|垢)+$/gi, '')
    .replace(/\d+$/g, '')
    .replace(/(?:sub|alt|sab|sabu|サブ|裏|別垢|本垢|垢)+$/gi, '')
  return { cleaned, stem: stem.length >= 3 ? stem : cleaned }
}

function bigrams (s) {
  const out = new Map()
  if (s.length < 2) return out
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2)
    out.set(bg, (out.get(bg) || 0) + 1)
  }
  return out
}

function diceSimilarity (a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const mapA = bigrams(a)
  const mapB = bigrams(b)
  let overlap = 0
  for (const [bg, cntA] of mapA) {
    const cntB = mapB.get(bg)
    if (cntB) overlap += Math.min(cntA, cntB)
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1))
}

function stringNameSimilarity (rawA, rawB) {
  const a = normalizeName(rawA)
  const b = normalizeName(rawB)
  if (!a.cleaned || !b.cleaned) return 0
  if (a.cleaned.length >= 3 && a.cleaned === b.cleaned) return 1
  if (a.stem.length >= 4 && a.stem === b.stem) return 0.92
  const shorter = a.stem.length <= b.stem.length ? a.stem : b.stem
  const longer = a.stem.length <= b.stem.length ? b.stem : a.stem
  if (shorter.length >= 4 && longer.includes(shorter)) {
    const ratio = shorter.length / longer.length
    if (ratio >= 0.5) return Math.min(0.95, 0.78 + 0.15 * ratio)
  }
  return Math.max(diceSimilarity(a.cleaned, b.cleaned), diceSimilarity(a.stem, b.stem))
}

function profileNames (profile) {
  return [profile?.username, profile?.globalName, profile?.nick]
    .map(s => String(s || '').trim())
    .filter(Boolean)
}

function nameSimilarity (profileA, profileB) {
  const namesA = profileNames(profileA)
  const namesB = profileNames(profileB)
  let best = 0
  let matchedPair = null
  for (const a of namesA) {
    for (const b of namesB) {
      const s = stringNameSimilarity(a, b)
      if (s > best) {
        best = s
        matchedPair = [a, b]
      }
    }
  }
  return { score: best, pair: matchedPair }
}

function stripNoise (text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[@#&!]?\d+>/g, ' ')
    .trim()
}

function extractStylometry (messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const texts = messages.map(m => stripNoise(m.content)).filter(Boolean)
  if (texts.length === 0) return null
  let totalChars = 0
  let excl = 0
  let quest = 0
  let fullPunct = 0
  let halfPunct = 0
  let comma = 0
  let ellipsis = 0
  let brackets = 0
  let period = 0
  let tilde = 0
  let newline = 0
  let kusa = 0
  let laughW = 0
  let laughKanji = 0
  let emoji = 0
  let hira = 0
  let kata = 0
  let kanji = 0
  let ascii = 0
  for (const t of texts) {
    totalChars += t.length
    if (/[!！]/.test(t)) excl++
    if (/[?？]/.test(t)) quest++
    if (/[！？（）]/.test(t)) fullPunct++
    if (/[!?()]/.test(t)) halfPunct++
    if (/、/.test(t)) comma++
    if (/…|\.{2,}|。。/.test(t)) ellipsis++
    if (/[「」『』（）()]/.test(t)) brackets++
    if (/[。.]\s*$/.test(t)) period++
    if (/[〜~ー]{2,}|[〜~]/.test(t)) tilde++
    if (t.includes('\n')) newline++
    if (/草/.test(t)) kusa++
    if (/(?:^|[^a-zA-Z])[wW]{1,}(?:$|[^a-zA-Z])|ｗ/.test(t)) laughW++
    if (/笑/.test(t)) laughKanji++
    if (/<a?:\w+:\d+>|\p{Extended_Pictographic}/u.test(t)) emoji++
    for (const ch of t) {
      const cp = ch.codePointAt(0)
      if (cp >= 0x3040 && cp <= 0x309F) hira++
      else if (cp >= 0x30A0 && cp <= 0x30FF) kata++
      else if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) kanji++
      else if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) ascii++
    }
  }
  // Consecutive rapid-burst posting rate (splitting thoughts into multiple short messages)
  const dated = messages
    .map(m => ({ ch: m.channelID || '', t: m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime() }))
    .filter(x => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t)
  let burstCount = 0
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].ch === dated[i - 1].ch && (dated[i].t - dated[i - 1].t) <= BURST_WINDOW_MS) {
      burstCount++
    }
  }
  const burstRatio = dated.length >= 2 ? burstCount / (dated.length - 1) : 0

  const n = texts.length
  const charDenom = Math.max(1, totalChars)
  return [
    Math.min(1, (totalChars / n) / 80),
    excl / n,
    quest / n,
    fullPunct / n,
    halfPunct / n,
    comma / n,
    ellipsis / n,
    brackets / n,
    period / n,
    tilde / n,
    newline / n,
    kusa / n,
    laughW / n,
    laughKanji / n,
    emoji / n,
    burstRatio,
    hira / charDenom,
    kata / charDenom,
    kanji / charDenom,
    ascii / charDenom
  ]
}

function cosineSimilarity (vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]
    const b = vecB[i]
    dot += a * b
    normA += a * a
    normB += b * b
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function mapCosineSimilarity (mapA, mapB) {
  if (!mapA || !mapB || mapA.size === 0 || mapB.size === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [k, a] of mapA) {
    normA += a * a
    const b = mapB.get(k)
    if (b) dot += a * b
  }
  for (const b of mapB.values()) normB += b * b
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function setIntersection (setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return []
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  const out = []
  for (const item of small) {
    if (large.has(item)) out.push(item)
  }
  return out
}

function overlapCoefficient (setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
  const inter = setIntersection(setA, setB).length
  return inter / Math.min(setA.size, setB.size)
}

function characterNgrams (messages, n = 3) {
  const grams = new Set()
  if (!Array.isArray(messages)) return grams
  for (const m of messages) {
    const clean = stripNoise(m.content).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    if (clean.length < n) continue
    for (let i = 0; i <= clean.length - n; i++) {
      grams.add(clean.slice(i, i + n))
      if (grams.size >= 4000) return grams
    }
  }
  return grams
}

function extractEmojis (messages) {
  const all = new Set()
  const custom = new Set()
  if (!Array.isArray(messages)) return { all, custom }
  for (const m of messages) {
    const text = String(m?.content || '')
    const customMatches = text.match(/<a?:\w+:\d+>/g) || []
    for (const c of customMatches) {
      custom.add(c)
      all.add(c)
    }
    const stripped = text.replace(/<a?:\w+:\d+>/g, ' ')
    const uniMatches = stripped.match(/\p{Extended_Pictographic}/gu) || []
    for (const u of uniMatches) all.add(u)
  }
  return { all, custom }
}

function extractMentionedUsers (messages, excludeIds = []) {
  const excluded = new Set((excludeIds || []).filter(Boolean).map(String))
  const targets = new Set()
  if (!Array.isArray(messages)) return targets
  for (const m of messages) {
    const text = String(m?.content || '')
    const re = /<@!?(\d{15,22})>/g
    let match
    while ((match = re.exec(text)) !== null) {
      if (!excluded.has(match[1])) targets.add(match[1])
    }
  }
  return targets
}

function normalizeUrlAnchor (rawUrl) {
  try {
    const u = new URL(rawUrl.replace(/[)>.,!?！？「」『』]+$/g, ''))
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
    if (!host || GENERIC_URL_HOSTS.has(host)) return null
    const segments = u.pathname.split('/').filter(Boolean).map(s => s.toLowerCase())
    if (host === 'x.com' || host === 'twitter.com') {
      const skip = new Set(['i', 'home', 'search', 'explore', 'hashtag', 'intent', 'share'])
      if (segments[0] && !skip.has(segments[0])) return `x.com/${segments[0]}`
      return null
    }
    if (host === 'youtube.com') {
      if (segments[0]?.startsWith('@')) return `youtube.com/${segments[0]}`
      if ((segments[0] === 'channel' || segments[0] === 'c') && segments[1]) return `youtube.com/${segments[0]}/${segments[1]}`
      const v = u.searchParams.get('v')
      if (v) return `youtube.com/watch?v=${v.toLowerCase()}`
      return null
    }
    if (host === 'youtu.be') {
      return segments[0] ? `youtube.com/watch?v=${segments[0]}` : null
    }
    if (host === 'twitch.tv' || host === 'github.com') {
      return segments[0] ? `${host}/${segments[0]}` : host
    }
    return host
  } catch (_) {
    return null
  }
}

function extractUrlDomains (messages) {
  const domains = new Set()
  if (!Array.isArray(messages)) return domains
  for (const m of messages) {
    const text = String(m?.content || '')
    const urls = text.match(/https?:\/\/[^\s<>()]+/gi) || []
    for (const raw of urls) {
      const anchor = normalizeUrlAnchor(raw)
      if (anchor) domains.add(anchor)
    }
  }
  return domains
}

// Extracts harder-to-fake vocabulary tokens (katakana words, kanji compounds, alphanumeric slang)
// while filtering out common everyday words.
function extractDistinctiveTokens (messages) {
  const tokens = new Set()
  if (!Array.isArray(messages)) return tokens
  for (const m of messages) {
    const clean = stripNoise(m?.content || '').normalize('NFKC').toLowerCase()
    if (!clean) continue
    const matches = clean.match(/[ァ-ヴー]{3,}|[一-龯々]{2,}|[a-z][a-z0-9_]{2,}/g) || []
    for (const tok of matches) {
      if (COMMON_TOKENS.has(tok)) continue
      tokens.add(tok)
      if (tokens.size >= 500) return tokens
    }
  }
  return tokens
}

// Extracts Japanese/Discord sentence-ending habits (語尾), which remain highly consistent even
// when an offender deliberately changes avatar, username, and ID.
function extractSentenceEndings (messages) {
  const endings = new Map()
  if (!Array.isArray(messages)) return endings
  for (const m of messages) {
    const lines = stripNoise(m?.content || '').normalize('NFKC').toLowerCase().split(/[\n。!?！？]+/)
    for (const line of lines) {
      const trimmed = line.replace(/[\s、,.…~〜ー「」『』()（）]+$/g, '').trim()
      if (trimmed.length < 3) continue
      const tail2 = trimmed.slice(-2)
      const tail3 = trimmed.length >= 4 ? trimmed.slice(-3) : null
      endings.set(tail2, (endings.get(tail2) || 0) + 1)
      if (tail3) endings.set(tail3, (endings.get(tail3) || 0) + 1.5)
    }
  }
  return endings
}

// Detects clean account-to-account activity handover (Account X stops posting -> Account Y starts
// posting with zero temporal overlap), catching disguised & pre-aged "sleeper" alts.
function analyzeActivityHandover (msgsA = [], msgsB = []) {
  if (!Array.isArray(msgsA) || !Array.isArray(msgsB) || msgsA.length < 3 || msgsB.length < 3) {
    return { disjoint: false, gapMs: null, direction: null, earlierLastTs: null, laterFirstTs: null }
  }
  const timesA = msgsA.map(m => (m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime())).filter(Number.isFinite)
  const timesB = msgsB.map(m => (m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime())).filter(Number.isFinite)
  if (timesA.length < 3 || timesB.length < 3) {
    return { disjoint: false, gapMs: null, direction: null, earlierLastTs: null, laterFirstTs: null }
  }
  const minA = Math.min(...timesA)
  const maxA = Math.max(...timesA)
  const minB = Math.min(...timesB)
  const maxB = Math.max(...timesB)
  const graceMs = 5 * 60 * 1000
  if (minA >= maxB - graceMs) {
    return {
      disjoint: true,
      gapMs: Math.max(0, minA - maxB),
      direction: 'B_to_A',
      earlierLastTs: new Date(maxB),
      laterFirstTs: new Date(minA)
    }
  }
  if (minB >= maxA - graceMs) {
    return {
      disjoint: true,
      gapMs: Math.max(0, minB - maxA),
      direction: 'A_to_B',
      earlierLastTs: new Date(maxA),
      laterFirstTs: new Date(minB)
    }
  }
  return { disjoint: false, gapMs: null, direction: null, earlierLastTs: null, laterFirstTs: null }
}

// Topic-agnostic Japanese TextDistortion (adapted from Stamatatos 2018 & Halvani POSNoise):
// masks topic/content stems (kanji compounds, katakana loanwords, alphanumeric words, numbers)
// while preserving hiragana particles, auxiliary endings, punctuation, newlines, and laugh habits.
function distortJapaneseTopic (text) {
  return stripNoise(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[一-龯々]{2,}/g, 'K')
    .replace(/[ァ-ヴー]{3,}/g, 'T')
    .replace(/(?<![a-z0-9_])(?!w+(?![a-z0-9_]))[a-z][a-z0-9_]{2,}/g, 'E')
    .replace(/\d{2,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

// Ružička (MinMax) similarity (Koppel & Winter 2014; Kestemont et al. 2016):
// sum_i min(x_i, y_i) / sum_i max(x_i, y_i). Optionally evaluated on a feature subset (for GI).
function ruzickaSimilarity (mapA, mapB, subset = null) {
  if (!mapA || !mapB || mapA.size === 0 || mapB.size === 0) return 0
  let num = 0
  let den = 0
  if (subset) {
    for (const k of subset) {
      const a = mapA.get(k) || 0
      const b = mapB.get(k) || 0
      if (a === 0 && b === 0) continue
      num += a < b ? a : b
      den += a > b ? a : b
    }
    return den === 0 ? 0 : num / den
  }
  for (const [k, a] of mapA) {
    const b = mapB.get(k) || 0
    num += a < b ? a : b
    den += a > b ? a : b
  }
  for (const [k, b] of mapB) {
    if (!mapA.has(k)) den += b
  }
  return den === 0 ? 0 : num / den
}

function normalizeFreqMap (counts) {
  let total = 0
  for (const v of counts.values()) total += v
  if (total <= 0) return new Map()
  const out = new Map()
  for (const [k, v] of counts) out.set(k, v / total)
  return out
}

// Relative-frequency character n-gram profile over topic-distorted Japanese text.
function topicAgnosticNgramFreq (messages, n = 3) {
  const counts = new Map()
  if (!Array.isArray(messages)) return counts
  for (const m of messages) {
    const clean = distortJapaneseTopic(m?.content || '').replace(/\s+/g, ' ')
    if (clean.length < n) continue
    for (let i = 0; i <= clean.length - n; i++) {
      const g = clean.slice(i, i + n)
      counts.set(g, (counts.get(g) || 0) + 1)
      if (counts.size >= 3000) break
    }
  }
  return normalizeFreqMap(counts)
}

// Japanese particle, auxiliary, pronoun & discourse-marker frequency profile (Jin 2002).
function extractJapaneseFunctionWords (messages) {
  const counts = new Map()
  let hits = 0
  if (!Array.isArray(messages)) return { freq: counts, hits: 0 }
  for (const m of messages) {
    const clean = stripNoise(m?.content || '').normalize('NFKC').toLowerCase()
    if (!clean) continue
    for (const fw of JAPANESE_FUNCTION_WORDS) {
      let idx = clean.indexOf(fw)
      while (idx !== -1) {
        counts.set(fw, (counts.get(fw) || 0) + 1)
        hits++
        idx = clean.indexOf(fw, idx + fw.length)
      }
    }
  }
  return { freq: normalizeFreqMap(counts), hits }
}

// Balanced Compression-Based Authorship Verification (COAV / symmetric NCD via deflate,
// Halvani et al. 2017–2021). Equalizes byte lengths to eliminate length bias.
function compressionSimilarity (msgsA, msgsB, { maxBytes = 4096, minBytes = 120 } = {}) {
  if (!Array.isArray(msgsA) || !Array.isArray(msgsB) || msgsA.length < 3 || msgsB.length < 3) return null
  const textA = msgsA.map(m => stripNoise(m?.content || '').normalize('NFKC').toLowerCase()).filter(Boolean).join('\n')
  const textB = msgsB.map(m => stripNoise(m?.content || '').normalize('NFKC').toLowerCase()).filter(Boolean).join('\n')
  const fullA = Buffer.from(textA, 'utf8')
  const fullB = Buffer.from(textB, 'utf8')
  const len = Math.min(fullA.length, fullB.length, maxBytes)
  if (len < minBytes) return null
  const bufA = fullA.subarray(0, len)
  const bufB = fullB.subarray(0, len)
  const cA = zlib.deflateRawSync(bufA, { level: 9 }).length
  const cB = zlib.deflateRawSync(bufB, { level: 9 }).length
  if (cA === 0 || cB === 0) return null
  const cAB = zlib.deflateRawSync(Buffer.concat([bufA, bufB]), { level: 9 }).length
  const cBA = zlib.deflateRawSync(Buffer.concat([bufB, bufA]), { level: 9 }).length
  const cJoint = (cAB + cBA) / 2
  const ncd = (cJoint - Math.min(cA, cB)) / Math.max(cA, cB)
  return Math.max(0, Math.min(1, 1 - ncd))
}

function combinedAvFeatureMap (messages) {
  const out = new Map()
  const grams = topicAgnosticNgramFreq(messages, 3)
  for (const [k, v] of grams) out.set(`g:${k}`, v)
  const { freq: fws } = extractJapaneseFunctionWords(messages)
  for (const [k, v] of fws) out.set(`f:${k}`, v * 1.5)
  const endings = extractSentenceEndings(messages)
  const normEndings = normalizeFreqMap(endings)
  for (const [k, v] of normEndings) out.set(`e:${k}`, v * 1.2)
  return out
}

function hashSeed (str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h || 1
}

function mulberry32 (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// General Impostors (GI) statistical authorship verification test (Koppel & Winter 2014;
// Seidman PAN-2013; Kestemont et al. 2016 Ružička metric). Tests whether candidate B consistently
// outranks in-domain server impostors across random 50% feature subsamples.
function generalImpostorsScore (msgsA, msgsB, impostorMsgLists = [], { rounds = 25, seedKey = 'gi' } = {}) {
  const validImpostors = (impostorMsgLists || []).filter(list => Array.isArray(list) && list.length >= 3).slice(0, 15)
  if (!Array.isArray(msgsA) || !Array.isArray(msgsB) || msgsA.length < 3 || msgsB.length < 3 || validImpostors.length < 3) {
    return null
  }
  const vecA = combinedAvFeatureMap(msgsA)
  const vecB = combinedAvFeatureMap(msgsB)
  if (vecA.size < 10 || vecB.size < 10) return null
  const impVecs = validImpostors.map(list => combinedAvFeatureMap(list)).filter(m => m.size >= 10)
  if (impVecs.length < 3) return null

  const vocabSet = new Set([...vecA.keys(), ...vecB.keys()])
  for (const iv of impVecs) {
    for (const k of iv.keys()) vocabSet.add(k)
  }
  const vocab = [...vocabSet]
  if (vocab.length < 12) return null

  const rand = mulberry32(hashSeed(seedKey))
  let wins = 0
  let totalChecks = 0
  for (let r = 0; r < rounds; r++) {
    const subset = []
    for (let i = 0; i < vocab.length; i++) {
      if (rand() < 0.5) subset.push(vocab[i])
    }
    if (subset.length < 6) continue
    const simAB = ruzickaSimilarity(vecA, vecB, subset)
    let maxAImp = -1
    let maxBImp = -1
    for (const iv of impVecs) {
      const sA = ruzickaSimilarity(vecA, iv, subset)
      if (sA > maxAImp) maxAImp = sA
      const sB = ruzickaSimilarity(vecB, iv, subset)
      if (sB > maxBImp) maxBImp = sB
    }
    if (simAB > maxAImp) wins++
    if (simAB > maxBImp) wins++
    totalChecks += 2
  }
  if (totalChecks === 0) return null
  return { score: wins / totalChecks, impostorCount: impVecs.length }
}

// Log-scale active-session inter-event times (arXiv:2407.04350, 2024): captures an individual's
// unconscious typing/posting cadence independently of message content or profile metadata.
function extractInterEventTimes (messages, { minSec = 1, maxSec = 3600 } = {}) {
  if (!Array.isArray(messages) || messages.length < 3) return []
  const times = messages
    .map(m => (m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const iets = []
  for (let i = 1; i < times.length; i++) {
    const sec = (times[i] - times[i - 1]) / 1000
    if (sec >= minSec && sec <= maxSec) iets.push(Math.log10(sec))
  }
  return iets.sort((a, b) => a - b)
}

// Exact two-sample Kolmogorov-Smirnov similarity (1 - D_KS) in [0, 1].
function ksSimilarity (sortedA, sortedB) {
  if (!Array.isArray(sortedA) || !Array.isArray(sortedB) || sortedA.length < 5 || sortedB.length < 5) return null
  const nA = sortedA.length
  const nB = sortedB.length
  let i = 0
  let j = 0
  let maxDiff = 0
  while (i < nA && j < nB) {
    const v = Math.min(sortedA[i], sortedB[j])
    while (i < nA && sortedA[i] <= v) i++
    while (j < nB && sortedB[j] <= v) j++
    const diff = Math.abs(i / nA - j / nB)
    if (diff > maxDiff) maxDiff = diff
  }
  return Math.max(0, Math.min(1, 1 - maxDiff))
}

// Laplace-smoothed Jensen-Shannon similarity (1 - sqrt(JSD)) over 24-hour JST circadian histograms.
function jensenShannonSimilarity (histA, histB, alpha = 0.25) {
  if (!Array.isArray(histA) || !Array.isArray(histB) || histA.length !== histB.length || histA.length === 0) return 0
  const n = histA.length
  const sumA = histA.reduce((acc, v) => acc + v, 0) + alpha * n
  const sumB = histB.reduce((acc, v) => acc + v, 0) + alpha * n
  if (sumA <= alpha * n || sumB <= alpha * n) return 0
  let klA = 0
  let klB = 0
  for (let i = 0; i < n; i++) {
    const p = (histA[i] + alpha) / sumA
    const q = (histB[i] + alpha) / sumB
    const m = 0.5 * (p + q)
    if (p > 0) klA += p * Math.log2(p / m)
    if (q > 0) klB += q * Math.log2(q / m)
  }
  const jsd = Math.max(0, Math.min(1, 0.5 * (klA + klB)))
  return 1 - Math.sqrt(jsd)
}

function jaccardSimilarity (setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let inter = 0
  for (const item of small) {
    if (large.has(item)) inter++
  }
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}

function hourHistogram (messages) {
  const hist = new Array(24).fill(0)
  if (!Array.isArray(messages)) return hist
  for (const m of messages) {
    const ts = m.ts instanceof Date ? m.ts : new Date(m.ts)
    if (Number.isNaN(ts.getTime())) continue
    const jstHour = (ts.getUTCHours() + 9) % 24
    hist[jstHour]++
  }
  return hist
}

function channelOverlap (msgsA, msgsB) {
  const setA = new Set((msgsA || []).map(m => m.channelID).filter(Boolean))
  const setB = new Set((msgsB || []).map(m => m.channelID).filter(Boolean))
  const shared = setIntersection(setA, setB)
  return {
    score: jaccardSimilarity(setA, setB),
    overlapCoeff: overlapCoefficient(setA, setB),
    sharedCount: shared.length
  }
}

// Counts distinct 1-minute windows where both accounts posted within windowMs of each other.
// Multiple simultaneous exchanges are strong counter-evidence (two distinct humans chatting).
function countSimultaneousMessages (msgsA, msgsB, windowMs = SIMULTANEOUS_WINDOW_MS) {
  if (!Array.isArray(msgsA) || !Array.isArray(msgsB) || !msgsA.length || !msgsB.length) return 0
  const timesA = msgsA.map(m => (m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime())).filter(Number.isFinite)
  const timesB = msgsB.map(m => (m.ts instanceof Date ? m.ts.getTime() : new Date(m.ts).getTime())).filter(Number.isFinite)
  const buckets = new Set()
  for (const ta of timesA) {
    for (const tb of timesB) {
      if (Math.abs(ta - tb) <= windowMs) {
        buckets.add(Math.floor(Math.min(ta, tb) / 60000))
        break
      }
    }
  }
  return buckets.size
}

function formatDurationJa (ms) {
  const mins = Math.max(1, Math.round(ms / 60000))
  if (mins < 60) return `${mins}分`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}時間`
  const days = Math.round(hours / 24)
  return `${days}日`
}

function scorePair ({
  suspectProfile,
  candidateProfile,
  suspectMessages = [],
  candidateMessages = [],
  suspectCentroid = null,
  candidateCentroid = null,
  impostorMessages = null,
  now = new Date()
}) {
  let raw = 0
  const signals = []
  const counterSignals = []
  const metrics = {
    timingDeltaMs: null,
    accountAgeAtJoinMs: null,
    createdAfterMod: false,
    inviteMatch: false,
    avatarHashMatch: false,
    nameSimilarity: 0,
    stylometrySimilarity: null,
    ngramSimilarity: null,
    topicAgnosticGrammarSim: null,
    functionWordSim: null,
    compressionSimilarity: null,
    impostorsScore: null,
    impostorsCount: 0,
    distinctiveVocabOverlap: null,
    sharedTokens: [],
    endingSimilarity: null,
    sharedEmojis: [],
    sharedMentionTargets: [],
    sharedUrlDomains: [],
    handoverGapMs: null,
    hourSimilarity: null,
    ietKsSimilarity: null,
    channelOverlap: null,
    embeddingSimilarity: null,
    simultaneousMinutes: 0
  }

  const suspIsMod = MOD_STATUSES.has(suspectProfile?.status)
  const candIsMod = MOD_STATUSES.has(candidateProfile?.status)
  const suspIsFormer = suspIsMod || suspectProfile?.status === 'left'
  const candIsFormer = candIsMod || candidateProfile?.status === 'left'

  // Determine direction symmetrically so `/altcheck find <bannedMain>` and
  // `/altcheck compare <oldMain> <newAlt>` score identically regardless of argument order.
  let modProfile = null
  let altProfile = suspectProfile
  if (candIsMod && !suspIsMod) {
    modProfile = candidateProfile
    altProfile = suspectProfile
  } else if (suspIsMod && !candIsMod) {
    modProfile = suspectProfile
    altProfile = candidateProfile
  } else if (candIsFormer && !suspIsFormer) {
    modProfile = candidateProfile
    altProfile = suspectProfile
  } else if (suspIsFormer && !candIsFormer) {
    modProfile = suspectProfile
    altProfile = candidateProfile
  } else {
    // Both have the same status class: treat the more recently joined (or more recently created)
    // account as the potential newer alt when inspecting post-event timing & account age at join.
    const tJoinS = suspectProfile?.joinedAt ? new Date(suspectProfile.joinedAt).getTime() : null
    const tJoinC = candidateProfile?.joinedAt ? new Date(candidateProfile.joinedAt).getTime() : null
    const tCreS = suspectProfile?.accountCreatedAt ? new Date(suspectProfile.accountCreatedAt).getTime() : null
    const tCreC = candidateProfile?.accountCreatedAt ? new Date(candidateProfile.accountCreatedAt).getTime() : null
    if (tJoinS != null && tJoinC != null && tJoinC > tJoinS) {
      modProfile = candIsFormer ? suspectProfile : null
      altProfile = candidateProfile
    } else if (tJoinS == null && tJoinC == null && tCreS != null && tCreC != null && tCreC > tCreS) {
      modProfile = candIsFormer ? suspectProfile : null
      altProfile = candidateProfile
    } else if (candIsFormer) {
      modProfile = candidateProfile
      altProfile = suspectProfile
    }
  }

  const joinedAt = altProfile?.joinedAt ? new Date(altProfile.joinedAt) : null
  const createdAt = altProfile?.accountCreatedAt ? new Date(altProfile.accountCreatedAt) : null
  const modStatusAt = modProfile?.statusAt ? new Date(modProfile.statusAt) : null
  const modIsOffender = MOD_STATUSES.has(modProfile?.status)

  // 1. BAN / kick / offender-role / leave timing proximity
  if (joinedAt && modStatusAt) {
    const delta = joinedAt.getTime() - modStatusAt.getTime()
    metrics.timingDeltaMs = delta
    if (delta >= -60 * 1000) {
      const clampedDelta = Math.max(0, delta)
      if (modIsOffender) {
        const actionLabel = modProfile.status === 'banned'
          ? 'BAN'
          : (modProfile.status === 'kicked' ? 'キック' : '違反者ロール付与')
        if (clampedDelta <= 2 * 3600 * 1000) {
          raw += 35
          signals.push(`処分側（${actionLabel}）から${formatDurationJa(clampedDelta)}後に他方が参加（極めて近接）`)
        } else if (clampedDelta <= 24 * 3600 * 1000) {
          raw += 25
          signals.push(`処分側（${actionLabel}）から${formatDurationJa(clampedDelta)}後に他方が参加`)
        } else if (clampedDelta <= 7 * 86400 * 1000) {
          raw += 15
          signals.push(`処分側（${actionLabel}）から${formatDurationJa(clampedDelta)}後に他方が参加`)
        } else if (clampedDelta <= 30 * 86400 * 1000) {
          raw += 8
          signals.push(`処分側（${actionLabel}）から${formatDurationJa(clampedDelta)}後に他方が参加`)
        }
      } else if (modProfile?.status === 'left' && clampedDelta <= 24 * 3600 * 1000) {
        raw += 12
        signals.push(`一方の退出から${formatDurationJa(clampedDelta)}以内に他方が参加`)
      }
    }
  }

  // 2. Account age at join & creation right after BAN/kick/offender-role
  if (createdAt) {
    const refTime = joinedAt ? joinedAt.getTime() : now.getTime()
    const ageMs = Math.max(0, refTime - createdAt.getTime())
    metrics.accountAgeAtJoinMs = ageMs
    if (ageMs < 24 * 3600 * 1000) {
      raw += 20
      signals.push(`参加時点でアカウント作成から24時間未満（${formatDurationJa(ageMs)}）`)
    } else if (ageMs < 7 * 86400 * 1000) {
      raw += 12
      signals.push(`参加時点でアカウント作成から7日未満（${formatDurationJa(ageMs)}）`)
    } else if (ageMs < 30 * 86400 * 1000) {
      raw += 5
      signals.push(`参加時点でアカウント作成から30日未満（${formatDurationJa(ageMs)}）`)
    }

    if (modIsOffender && modStatusAt) {
      const createdAfter = createdAt.getTime() - modStatusAt.getTime()
      if (createdAfter >= -60 * 1000 && createdAfter <= 14 * 86400 * 1000) {
        metrics.createdAfterMod = true
        raw += 10
        signals.push('BAN/キック/違反者ロール付与後に新規作成されたアカウント')
      }
    }
  }

  // 3. Invite code match
  if (suspectProfile?.inviteCode && candidateProfile?.inviteCode && suspectProfile.inviteCode === candidateProfile.inviteCode) {
    metrics.inviteMatch = true
    raw += 15
    signals.push(`同じ招待リンク（${suspectProfile.inviteCode}）から参加`)
  }

  // 4. Exact custom avatar hash match
  if (suspectProfile?.avatarHash && candidateProfile?.avatarHash && suspectProfile.avatarHash === candidateProfile.avatarHash) {
    metrics.avatarHashMatch = true
    raw += 35
    signals.push('カスタムアバター画像ハッシュが完全一致')
  }

  // 5. Username / display name / nickname similarity
  const nameRes = nameSimilarity(suspectProfile, candidateProfile)
  metrics.nameSimilarity = Number(nameRes.score.toFixed(3))
  if (nameRes.score >= 0.85) {
    raw += 30
    signals.push(`名前が非常に類似（${Math.round(nameRes.score * 100)}%: ${nameRes.pair[0]} / ${nameRes.pair[1]}）`)
  } else if (nameRes.score >= 0.65) {
    raw += 20
    signals.push(`名前が類似（${Math.round(nameRes.score * 100)}%: ${nameRes.pair[0]} / ${nameRes.pair[1]}）`)
  } else if (nameRes.score >= 0.45) {
    raw += 10
    signals.push(`名前に共通部分あり（${Math.round(nameRes.score * 100)}%: ${nameRes.pair[0]} / ${nameRes.pair[1]}）`)
  }

  // 6. Identity-independent behavioral, linguistic, content-anchor & timeline signals
  //    (designed to catch disguised alts even when avatar, username, ID, and topic all change)
  if (suspectMessages.length >= 3 && candidateMessages.length >= 3) {
    // Anti-false-positive check first so simultaneous conversations suppress handover boosts.
    const simultaneous = countSimultaneousMessages(suspectMessages, candidateMessages)
    metrics.simultaneousMinutes = simultaneous

    const styloA = extractStylometry(suspectMessages)
    const styloB = extractStylometry(candidateMessages)
    if (styloA && styloB) {
      const styloSim = cosineSimilarity(styloA, styloB)
      metrics.stylometrySimilarity = Number(styloSim.toFixed(3))
      if (styloSim >= 0.94) {
        raw += 20
        signals.push(`文体・表記クセが高度に一致（類似度 ${Math.round(styloSim * 100)}%）`)
      } else if (styloSim >= 0.88) {
        raw += 12
        signals.push(`文体・表記クセが類似（類似度 ${Math.round(styloSim * 100)}%）`)
      } else if (styloSim >= 0.82) {
        raw += 6
        signals.push(`文体・表記クセにやや類似傾向（類似度 ${Math.round(styloSim * 100)}%）`)
      }
    }

    const gramsA = characterNgrams(suspectMessages, 3)
    const gramsB = characterNgrams(candidateMessages, 3)
    if (gramsA.size >= 20 && gramsB.size >= 20) {
      const ngramSim = jaccardSimilarity(gramsA, gramsB)
      metrics.ngramSimilarity = Number(ngramSim.toFixed(3))
      if (ngramSim >= 0.25) {
        raw += 22
        signals.push(`表現・言い回しの重複が高い（3-gram Jaccard ${Math.round(ngramSim * 100)}%）`)
      } else if (ngramSim >= 0.16) {
        raw += 14
        signals.push(`表現・言い回しに共通点が多い（3-gram Jaccard ${Math.round(ngramSim * 100)}%）`)
      } else if (ngramSim >= 0.10) {
        raw += 7
        signals.push(`表現・言い回しに一部共通点あり（3-gram Jaccard ${Math.round(ngramSim * 100)}%）`)
      }
    }

    // Topic-agnostic grammatical skeleton via Japanese TextDistortion + Ružička MinMax
    // (Stamatatos 2018 / Halvani POSNoise / Kestemont 2016): matches style even across different topics.
    const distA = topicAgnosticNgramFreq(suspectMessages, 3)
    const distB = topicAgnosticNgramFreq(candidateMessages, 3)
    if (distA.size >= 15 && distB.size >= 15) {
      const gramSim = ruzickaSimilarity(distA, distB)
      metrics.topicAgnosticGrammarSim = Number(gramSim.toFixed(3))
      if (gramSim >= 0.35) {
        raw += 18
        signals.push(`話題に依存しない文法骨格（助詞・語尾・句読点構造）が高度に一致（MinMax ${Math.round(gramSim * 100)}%）`)
      } else if (gramSim >= 0.25) {
        raw += 10
        signals.push(`話題に依存しない文法骨格が類似（MinMax ${Math.round(gramSim * 100)}%）`)
      }
    }

    // Japanese function-word / particle / discourse-marker profile (Jin 2002)
    const fwA = extractJapaneseFunctionWords(suspectMessages)
    const fwB = extractJapaneseFunctionWords(candidateMessages)
    if (fwA.hits >= 4 && fwB.hits >= 4) {
      const fwSim = ruzickaSimilarity(fwA.freq, fwB.freq)
      metrics.functionWordSim = Number(fwSim.toFixed(3))
      if (fwSim >= 0.55) {
        raw += 14
        signals.push(`日本語の助詞・接続語・機能語の使用分布が強く一致（MinMax ${Math.round(fwSim * 100)}%）`)
      } else if (fwSim >= 0.38) {
        raw += 7
        signals.push(`日本語の助詞・接続語・機能語の使用分布が類似（MinMax ${Math.round(fwSim * 100)}%）`)
      }
    }

    // Balanced Compression-Based Authorship Verification (COAV / symmetric NCD, Halvani et al.)
    const compSim = compressionSimilarity(suspectMessages, candidateMessages)
    if (compSim != null) {
      metrics.compressionSimilarity = Number(compSim.toFixed(3))
      if (compSim >= 0.34) {
        raw += 14
        signals.push(`圧縮ベース文体類似度（COAV/NCD）が高い（${Math.round(compSim * 100)}%）`)
      } else if (compSim >= 0.24) {
        raw += 7
        signals.push(`圧縮ベース文体類似度（COAV/NCD）に類似傾向（${Math.round(compSim * 100)}%）`)
      }
    }

    // In-domain General Impostors statistical test (Koppel & Winter 2014 / PAN winner)
    if (Array.isArray(impostorMessages) && impostorMessages.length >= 3) {
      const seedKey = `${suspectProfile?.userID || 'a'}:${candidateProfile?.userID || 'b'}`
      const gi = generalImpostorsScore(suspectMessages, candidateMessages, impostorMessages, { seedKey })
      if (gi) {
        metrics.impostorsScore = Number(gi.score.toFixed(3))
        metrics.impostorsCount = gi.impostorCount
        if (gi.score >= 0.75) {
          raw += 22
          signals.push(`General Impostors 統計検定でサーバー内他発言者（${gi.impostorCount}人）を上回る独自文体一致（勝率 ${Math.round(gi.score * 100)}%）`)
        } else if (gi.score >= 0.55) {
          raw += 14
          signals.push(`General Impostors 統計検定で有力な文体一致（勝率 ${Math.round(gi.score * 100)}%／比較 ${gi.impostorCount}人）`)
        } else if (gi.score >= 0.40) {
          raw += 7
          signals.push(`General Impostors 統計検定でやや類似（勝率 ${Math.round(gi.score * 100)}%／比較 ${gi.impostorCount}人）`)
        } else if (gi.score <= 0.08 && gi.impostorCount >= 5 && nameRes.score < 0.45 && !metrics.avatarHashMatch) {
          counterSignals.push(`サーバー内他発言者（${gi.impostorCount}人）と比較した General Impostors 検定では文体の独自一致が低い（勝率 ${Math.round(gi.score * 100)}%）`)
        }
      }
    }

    // Distinctive vocabulary overlap (katakana slang, kanji compounds, alphanumeric terms)
    const tokensA = extractDistinctiveTokens(suspectMessages)
    const tokensB = extractDistinctiveTokens(candidateMessages)
    if (tokensA.size >= 4 && tokensB.size >= 4) {
      const sharedTok = setIntersection(tokensA, tokensB)
      const tokOverlap = overlapCoefficient(tokensA, tokensB)
      metrics.distinctiveVocabOverlap = Number(tokOverlap.toFixed(3))
      metrics.sharedTokens = sharedTok.slice(0, 8)
      if (sharedTok.length >= 5 && tokOverlap >= 0.25) {
        raw += 14
        signals.push(`固有語彙・キーワードの重複が高い（${sharedTok.length}語一致: ${sharedTok.slice(0, 4).join('・')}）`)
      } else if (sharedTok.length >= 3 && tokOverlap >= 0.18) {
        raw += 8
        signals.push(`固有語彙・キーワードに共通点あり（${sharedTok.length}語一致: ${sharedTok.slice(0, 4).join('・')}）`)
      }
    }

    // Sentence-ending habits (語尾)
    const endingsA = extractSentenceEndings(suspectMessages)
    const endingsB = extractSentenceEndings(candidateMessages)
    if (endingsA.size >= 4 && endingsB.size >= 4) {
      const endSim = mapCosineSimilarity(endingsA, endingsB)
      metrics.endingSimilarity = Number(endSim.toFixed(3))
      if (endSim >= 0.65) {
        raw += 12
        signals.push(`語尾・文末表現のクセが強く一致（類似度 ${Math.round(endSim * 100)}%）`)
      } else if (endSim >= 0.45) {
        raw += 6
        signals.push(`語尾・文末表現のクセが類似（類似度 ${Math.round(endSim * 100)}%）`)
      }
    }

    // Shared emoji palette (custom Discord emojis + Unicode emojis)
    const emojisA = extractEmojis(suspectMessages)
    const emojisB = extractEmojis(candidateMessages)
    if (emojisA.all.size > 0 && emojisB.all.size > 0) {
      const sharedAll = setIntersection(emojisA.all, emojisB.all)
      const sharedCustom = setIntersection(emojisA.custom, emojisB.custom)
      const emojiOverlap = overlapCoefficient(emojisA.all, emojisB.all)
      metrics.sharedEmojis = sharedAll.slice(0, 6)
      if (sharedCustom.length >= 2 || (sharedAll.length >= 3 && emojiOverlap >= 0.4)) {
        raw += 10
        signals.push(`よく使う絵文字・スタンプが一致（${sharedAll.length}種共通）`)
      } else if (sharedAll.length >= 2 && emojiOverlap >= 0.35) {
        raw += 5
        signals.push(`使用絵文字に共通点あり（${sharedAll.length}種共通）`)
      }
    }

    // Shared mentioned / targeted users (trolls/offenders often keep targeting the same members)
    const excludeSelf = [suspectProfile?.userID, candidateProfile?.userID].filter(Boolean)
    const targetsA = extractMentionedUsers(suspectMessages, excludeSelf)
    const targetsB = extractMentionedUsers(candidateMessages, excludeSelf)
    if (targetsA.size > 0 && targetsB.size > 0) {
      const sharedTargets = setIntersection(targetsA, targetsB)
      metrics.sharedMentionTargets = sharedTargets.slice(0, 5)
      if (sharedTargets.length >= 2) {
        raw += 10
        signals.push(`同じ特定メンバー（${sharedTargets.length}名）へのメンション・絡みが重複`)
      }
    }

    // Shared external URL domains / accounts / specific videos
    const domainsA = extractUrlDomains(suspectMessages)
    const domainsB = extractUrlDomains(candidateMessages)
    if (domainsA.size > 0 && domainsB.size > 0) {
      const sharedDomains = setIntersection(domainsA, domainsB)
      metrics.sharedUrlDomains = sharedDomains.slice(0, 5)
      if (sharedDomains.length >= 2) {
        raw += 14
        signals.push(`同じ外部URL・リンク先を複数共有（${sharedDomains.slice(0, 3).join(', ')}）`)
      } else if (sharedDomains.length === 1) {
        raw += 8
        signals.push(`同じ外部URL・リンク先を共有（${sharedDomains[0]}）`)
      }
    }

    // Circadian 24h JST posting distribution via Laplace-smoothed Jensen-Shannon similarity
    if (suspectMessages.length >= 5 && candidateMessages.length >= 5) {
      const hourSim = jensenShannonSimilarity(hourHistogram(suspectMessages), hourHistogram(candidateMessages))
      metrics.hourSimilarity = Number(hourSim.toFixed(3))
      if (hourSim >= 0.75) {
        raw += 10
        signals.push(`活動時間帯分布（JST・JSD類似度 ${Math.round(hourSim * 100)}%）が強く一致`)
      } else if (hourSim >= 0.62) {
        raw += 5
        signals.push(`活動時間帯分布（JST・JSD類似度 ${Math.round(hourSim * 100)}%）が類似`)
      }
    }

    // Inter-Event Time (IET) temporal fingerprint via two-sample Kolmogorov-Smirnov test (arXiv:2407.04350)
    const ietA = extractInterEventTimes(suspectMessages)
    const ietB = extractInterEventTimes(candidateMessages)
    const ietSim = ksSimilarity(ietA, ietB)
    if (ietSim != null) {
      metrics.ietKsSimilarity = Number(ietSim.toFixed(3))
      if (ietSim >= 0.80) {
        raw += 8
        signals.push(`投稿間隔（Inter-Event Time）のリズム分布が強く一致（KS類似度 ${Math.round(ietSim * 100)}%）`)
      } else if (ietSim >= 0.70) {
        raw += 4
        signals.push(`投稿間隔（Inter-Event Time）のリズム分布が類似（KS類似度 ${Math.round(ietSim * 100)}%）`)
      }
    }

    const chan = channelOverlap(suspectMessages, candidateMessages)
    metrics.channelOverlap = Number(chan.score.toFixed(3))
    if (chan.sharedCount >= 3 && (chan.score >= 0.5 || chan.overlapCoeff >= 0.75)) {
      raw += 10
      signals.push(`よく発言するチャンネルが強く重複（${chan.sharedCount}チャンネル）`)
    } else if (chan.sharedCount >= 2 && (chan.score >= 0.5 || chan.overlapCoeff >= 0.65)) {
      raw += 8
      signals.push(`よく発言するチャンネルが重複（${chan.sharedCount}チャンネル）`)
    }

    // Activity handover / disjoint lifespan (catches disguised & sleeper alts where A stops -> B starts)
    if (simultaneous === 0) {
      const handover = analyzeActivityHandover(suspectMessages, candidateMessages)
      if (handover.disjoint && handover.gapMs != null) {
        metrics.handoverGapMs = handover.gapMs
        if (handover.gapMs <= 24 * 3600 * 1000) {
          raw += 18
          signals.push(`活動期間の入れ替わりを検知（一方の最終発言から${formatDurationJa(Math.max(60000, handover.gapMs))}後に他方が活動開始・重複なし）`)
        } else if (handover.gapMs <= 7 * 86400 * 1000) {
          raw += 12
          signals.push(`活動期間の入れ替わりあり（一方の停止から${formatDurationJa(handover.gapMs)}後に他方が活動開始・重複なし）`)
        } else if (handover.gapMs <= 30 * 86400 * 1000 && (suspIsFormer || candIsFormer)) {
          raw += 8
          signals.push(`処分・退出側の活動停止後に他方が活動開始（間隔 ${formatDurationJa(handover.gapMs)}・重複なし）`)
        }
      }
    }

    if (suspectCentroid && candidateCentroid) {
      const embSim = cosineSimilarity(suspectCentroid, candidateCentroid)
      metrics.embeddingSimilarity = Number(embSim.toFixed(3))
      if (embSim >= 0.85) {
        raw += 22
        signals.push(`発言内容の意味ベクトルが極めて類似（${Math.round(embSim * 100)}%）`)
      } else if (embSim >= 0.78) {
        raw += 16
        signals.push(`発言内容の意味ベクトルが強く類似（${Math.round(embSim * 100)}%）`)
      } else if (embSim >= 0.70) {
        raw += 10
        signals.push(`発言内容の意味ベクトルが類似（${Math.round(embSim * 100)}%）`)
      }
    }

    // Anti-false-positive penalty for simultaneous exchanges
    if (simultaneous >= 3) {
      raw -= 25
      counterSignals.push(`同時刻（15秒以内）に ${simultaneous} 回以上やり取りしており、別人の可能性が高い`)
    } else if (simultaneous >= 1) {
      raw -= 5
      counterSignals.push(`同時刻（15秒以内）に ${simultaneous} 回の発言あり`)
    }
  }

  // 7. Delete-and-repost anti-evasion (works even with < 3 messages per account)
  const crossDeleteReposts = detectCrossAccountDeleteRepost(suspectMessages, candidateMessages)
  metrics.crossAccountDeleteReposts = crossDeleteReposts.length
  if (crossDeleteReposts.length > 0) {
    const best = crossDeleteReposts[0]
    raw += 45
    const delKind = best.deletionActor === 'moderator'
      ? 'モデレーター削除→別アカウントで再投稿'
      : (best.deletionActor === 'self' ? '本人削除→別アカウントで再投稿' : '削除→別アカウントで再投稿')
    signals.push(`アカウント間での「${delKind}」を検知（${formatDurationJa(Math.max(60000, best.deltaMs))}以内に類似度${Math.round(best.similarity * 100)}%の内容を再投稿）`)
  }

  const suspectDel = analyzeSelfDeleteBehavior(suspectMessages)
  const candDel = analyzeSelfDeleteBehavior(candidateMessages)
  metrics.deletedMessageCount = suspectDel.deletedCount + candDel.deletedCount
  metrics.modDeletedMessageCount = suspectDel.modDeletedCount + candDel.modDeletedCount
  metrics.selfDeleteRepostCount = suspectDel.selfDeleteRepostCount
  metrics.rapidDeleteCount = suspectDel.rapidDeleteCount
  metrics.modDeletedRepostCount = suspectDel.modDeletedRepostCount
  if (suspectDel.selfDeleteRepostCount >= 2 || suspectDel.rapidDeleteCount >= 3) {
    if (raw >= 15) raw += 8
    signals.push(`調査対象に本人削除→再投稿・投稿直後の自己削除を複数回確認（本人削除等 ${suspectDel.selfOrUnknownDeletedCount} 件 / 履歴隠滅・検知回避の傾向）`)
  }
  if (suspectDel.modDeletedCount > 0 || candDel.modDeletedCount > 0) {
    const parts = []
    if (suspectDel.modDeletedCount > 0) parts.push(`調査対象 ${suspectDel.modDeletedCount} 件`)
    if (candDel.modDeletedCount > 0) parts.push(`候補 ${candDel.modDeletedCount} 件`)
    signals.push(`モデレーターによる削除済み発言を照合対象に含めています（${parts.join('・')}）`)
  }

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  return { score, signals, counterSignals, metrics }
}

const CROSS_DELETE_REPOST_WINDOW_MS = 10 * 60 * 1000
const SELF_DELETE_REPOST_WINDOW_MS = 3 * 60 * 1000
const RAPID_DELETE_WINDOW_MS = 5 * 60 * 1000

function normalizeForRepost (text) {
  return stripNoise(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s、。,.!?！？「」『』()（）[\]【】~〜ー\-_・…]/g, '')
}

function repostTextSimilarity (textA, textB) {
  const a = normalizeForRepost(textA)
  const b = normalizeForRepost(textB)
  if (a.length < 6 || b.length < 6) return 0
  if (a === b) return 1
  return diceSimilarity(a, b)
}

function msgTimeMs (m) {
  const d = m?.ts instanceof Date ? m.ts : new Date(m?.ts)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

function deleteTimeMs (m) {
  const d = m?.eventTs instanceof Date ? m.eventTs : (m?.eventTs ? new Date(m.eventTs) : null)
  if (d && !Number.isNaN(d.getTime())) return d.getTime()
  return msgTimeMs(m)
}

// Detects when one account's message was deleted (by self or by a moderator) and the other account
// posted identical or near-identical text within 10 minutes.
function detectCrossAccountDeleteRepost (msgsA = [], msgsB = [], windowMs = CROSS_DELETE_REPOST_WINDOW_MS) {
  const matches = []
  const scan = (deletedSource, postedSource) => {
    const deletedList = (deletedSource || []).filter(m => m?.deleted && m.content)
    const postedList = (postedSource || []).filter(m => m?.content)
    for (const del of deletedList) {
      const delAt = deleteTimeMs(del)
      if (delAt == null) continue
      for (const post of postedList) {
        const postAt = msgTimeMs(post)
        if (postAt == null) continue
        const delta = postAt - delAt
        if (delta < -30 * 1000 || delta > windowMs) continue
        const sim = repostTextSimilarity(del.content, post.content)
        if (sim >= 0.75) {
          matches.push({
            deletedBy: del.authorID || null,
            deletionActor: del.deletedBy || 'unknown',
            repostedBy: post.authorID || null,
            similarity: Number(sim.toFixed(3)),
            deltaMs: Math.abs(delta),
            excerpt: String(post.content).slice(0, 80)
          })
          break
        }
      }
    }
  }
  scan(msgsA, msgsB)
  scan(msgsB, msgsA)
  matches.sort((a, b) => b.similarity - a.similarity || a.deltaMs - b.deltaMs)
  return matches
}

// Separates moderator-deleted messages from self-deleted messages so moderator cleanup of
// rule-breaking posts is never misattributed as self-scrubbing evasion.
function analyzeSelfDeleteBehavior (messages = []) {
  let deletedCount = 0
  let modDeletedCount = 0
  let selfOrUnknownDeletedCount = 0
  let editedCount = 0
  let rapidDeleteCount = 0
  let selfDeleteRepostCount = 0
  let modDeletedRepostCount = 0
  const selfDeletedList = []
  const modDeletedList = []
  const liveList = []
  for (const m of messages || []) {
    if (!m) continue
    if (m.deleted) {
      deletedCount++
      if (m.deletedBy === 'moderator') {
        modDeletedCount++
        modDeletedList.push(m)
      } else {
        selfOrUnknownDeletedCount++
        selfDeletedList.push(m)
        const orig = msgTimeMs(m)
        const delAt = m.eventTs ? new Date(m.eventTs).getTime() : null
        if (orig != null && delAt != null && delAt >= orig && (delAt - orig) <= RAPID_DELETE_WINDOW_MS) {
          rapidDeleteCount++
        }
      }
    } else if (m.editedBefore) {
      editedCount++
    } else {
      liveList.push(m)
    }
  }
  const hasQuickRepost = del => {
    const delAt = deleteTimeMs(del)
    if (delAt == null) return false
    return liveList.some(post => {
      const postAt = msgTimeMs(post)
      return postAt != null && postAt >= delAt - 10 * 1000 && (postAt - delAt) <= SELF_DELETE_REPOST_WINDOW_MS
    })
  }
  for (const del of selfDeletedList) {
    if (hasQuickRepost(del)) selfDeleteRepostCount++
  }
  for (const del of modDeletedList) {
    if (hasQuickRepost(del)) modDeletedRepostCount++
  }
  return {
    deletedCount,
    modDeletedCount,
    selfOrUnknownDeletedCount,
    editedCount,
    rapidDeleteCount,
    selfDeleteRepostCount,
    modDeletedRepostCount
  }
}

// --- Candidate discovery ---

function mergeProfiles (dbProfile, liveProfile) {
  if (!dbProfile) return liveProfile
  if (!liveProfile) return dbProfile
  let status = liveProfile.status || dbProfile.status
  if (liveProfile.status === 'restricted') {
    status = 'restricted'
  } else if (dbProfile.status === 'restricted' && !liveProfile._hasKnownRoles) {
    status = 'restricted'
  }
  return {
    ...dbProfile,
    username: liveProfile.username || dbProfile.username,
    globalName: liveProfile.globalName || dbProfile.globalName,
    nick: liveProfile.nick || dbProfile.nick,
    avatarHash: liveProfile.avatarHash || dbProfile.avatarHash,
    avatarURL: liveProfile.avatarURL || dbProfile.avatarURL,
    accountCreatedAt: dbProfile.accountCreatedAt || liveProfile.accountCreatedAt,
    joinedAt: dbProfile.joinedAt || liveProfile.joinedAt,
    status,
    statusAt: status === 'restricted' ? (dbProfile.statusAt || liveProfile.statusAt) : (liveProfile.statusAt || dbProfile.statusAt),
    moderationReason: status === 'restricted'
      ? (dbProfile.moderationReason || liveProfile.moderationReason || '違反者ロール付与')
      : (dbProfile.moderationReason || liveProfile.moderationReason)
  }
}

async function resolveProfile (guild, userID) {
  const dbProfile = await altDB.getMemberProfile(guild.id, userID).catch(() => null)
  const member = guild.members?.get?.(userID) || null
  const liveProfile = member ? profileFromMember(member) : null
  if (dbProfile || liveProfile) return mergeProfiles(dbProfile, liveProfile)
  let restUser = null
  if (typeof global.bot?.getRESTUser === 'function') {
    restUser = await global.bot.getRESTUser(userID).catch(() => null)
  }
  if (restUser) return profileFromUser(restUser, { status: 'unknown' })
  return {
    userID,
    username: null,
    globalName: null,
    nick: null,
    avatarHash: null,
    avatarURL: null,
    accountCreatedAt: snowflakeToDate(userID),
    joinedAt: null,
    inviteCode: null,
    status: 'unknown',
    statusAt: null,
    moderationReason: null
  }
}

// Text, voice (its text chat), announcement, stage, and threads.
const READABLE_CHANNEL_TYPES = [0, 2, 5, 10, 11, 12, 13]
const SKIPPED_MESSAGE_TYPES = [23, 24] // automod

function canBotReadChannel (channel) {
  if (!channel || !READABLE_CHANNEL_TYPES.includes(channel.type)) return false
  if (channel.lastMessageID === null) return false
  const botId = global.bot?.user?.id
  if (!botId || typeof channel.permissionsOf !== 'function') return false
  try {
    const perms = channel.permissionsOf(botId)
    if (!perms) return false
    const view = typeof perms.has === 'function' ? perms.has('viewChannel') : Boolean(perms.json?.viewChannel)
    const history = typeof perms.has === 'function' ? perms.has('readMessageHistory') : Boolean(perms.json?.readMessageHistory)
    return view && history
  } catch (_) {
    return false
  }
}

// Collects every readable channel and active thread in the server (including audit-ignored and
// private channels the bot has access to) for moderator /altcheck investigations.
async function readableChannelsOf (guild) {
  const byId = new Map()
  const add = ch => {
    if (ch?.id && !byId.has(ch.id) && canBotReadChannel(ch)) byId.set(ch.id, ch)
  }
  if (guild?.channels) {
    for (const ch of guild.channels.values()) add(ch)
  }
  if (guild?.threads) {
    for (const th of guild.threads.values()) add(th)
  }
  if (typeof guild?.getActiveThreads === 'function') {
    const res = await guild.getActiveThreads().catch(() => null)
    const list = Array.isArray(res?.threads) ? res.threads : (Array.isArray(res) ? res : [])
    for (const th of list) add(th)
  }
  return [...byId.values()]
}

function mergeMessageLists (listA = [], listB = [], limit = 60) {
  const byId = new Map()
  for (const m of [...listA, ...listB]) {
    if (!m || !m.content) continue
    const key = m.id || `${m.authorID}:${m.channelID}:${new Date(m.ts).getTime()}:${m.content.slice(0, 30)}`
    if (!byId.has(key)) byId.set(key, m)
  }
  return [...byId.values()]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, limit)
}

async function fetchAllGuildChannelMessages (guild, { perChannel = 100, concurrency = 4 } = {}) {
  const byAuthor = new Map()
  const authors = new Map()
  if (!guild || typeof global.bot?.getMessages !== 'function') {
    return { byAuthor, authors, channelsScanned: 0, totalMessages: 0 }
  }
  const channels = await readableChannelsOf(guild)
  if (!channels.length) return { byAuthor, authors, channelsScanned: 0, totalMessages: 0 }

  let channelsScanned = 0
  let totalMessages = 0
  let cursor = 0

  const worker = async () => {
    while (cursor < channels.length) {
      const ch = channels[cursor++]
      const raw = await global.bot.getMessages(ch.id, { limit: perChannel }).catch(() => null)
      if (!Array.isArray(raw)) continue
      channelsScanned++
      for (const m of raw) {
        if (!m || SKIPPED_MESSAGE_TYPES.includes(m.type)) continue
        const author = m.author
        if (!author?.id || author.bot) continue
        const content = String(m.content || '').trim()
        if (!content) continue
        totalMessages++
        if (!authors.has(author.id)) {
          authors.set(author.id, profileFromUser(author, { status: 'active' }))
        }
        if (!byAuthor.has(author.id)) byAuthor.set(author.id, [])
        byAuthor.get(author.id).push({
          id: m.id,
          authorID: author.id,
          channelID: ch.id,
          content,
          ts: m.timestamp ? new Date(m.timestamp) : new Date(0)
        })
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, channels.length) }, () => worker())
  await Promise.all(workers)

  for (const [authorID, msgs] of byAuthor) {
    byAuthor.set(authorID, msgs.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()))
  }
  return { byAuthor, authors, channelsScanned, totalMessages }
}

function pickImpostorMessages (msgsByAuthor, excludeIds = [], maxImpostors = 15) {
  if (!msgsByAuthor || typeof msgsByAuthor.entries !== 'function') return []
  const excluded = new Set((excludeIds || []).filter(Boolean))
  const lists = []
  for (const [authorID, msgs] of msgsByAuthor.entries()) {
    if (!authorID || excluded.has(authorID)) continue
    if (Array.isArray(msgs) && msgs.length >= 3) {
      lists.push(msgs)
      if (lists.length >= maxImpostors) break
    }
  }
  return lists
}

async function findCandidates (guild, suspectProfile, suspectMessages = [], {
  trigger = 'manual',
  now = new Date(),
  limit = 5,
  includeGuildMembers = true,
  liveMessagesByAuthor = null,
  liveAuthors = null
} = {}) {
  const stored = await altDB.getCandidateProfiles(guild.id, suspectProfile.userID, { limit: 200 }).catch(() => [])
  const candidateMap = new Map()
  for (const p of stored) {
    if (p?.userID && p.userID !== suspectProfile.userID) candidateMap.set(p.userID, p)
  }

  if (includeGuildMembers && guild.members) {
    for (const member of guild.members.values()) {
      const mUser = member.user || member
      const mId = member.id || mUser?.id
      if (!mId || mId === suspectProfile.userID || member.bot || mUser?.bot) continue
      const live = profileFromMember(member)
      if (!live) continue
      const existing = candidateMap.get(mId)
      candidateMap.set(mId, existing ? mergeProfiles(existing, live) : live)
    }
  }

  if (liveAuthors) {
    for (const [authorID, authorProfile] of liveAuthors) {
      if (!authorID || authorID === suspectProfile.userID || !authorProfile) continue
      const existing = candidateMap.get(authorID)
      candidateMap.set(authorID, existing ? mergeProfiles(existing, authorProfile) : authorProfile)
    }
  }

  let recentMsgsByAuthor = new Map()
  if (suspectMessages.length >= 1) {
    recentMsgsByAuthor = await altDB.getRecentAuthorsMessages(guild.id, suspectProfile.userID, {
      authorLimit: 60,
      perAuthor: 30,
      days: 30
    }).catch(() => new Map())
  }

  if (liveMessagesByAuthor) {
    for (const [authorID, liveMsgs] of liveMessagesByAuthor) {
      if (!authorID || authorID === suspectProfile.userID) continue
      const merged = mergeMessageLists(recentMsgsByAuthor.get(authorID) || [], liveMsgs, 50)
      if (merged.length) recentMsgsByAuthor.set(authorID, merged)
    }
  }

  // Semantic discovery via pgvector: pulls behaviorally/topically similar accounts directly into
  // the candidate pool even when username, avatar, ID, and join date are completely disguised.
  let suspectCentroid = null
  const centroidByAuthor = new Map()
  if (suspectMessages.length >= 3) {
    suspectCentroid = await altDB.getAuthorEmbeddingCentroid(guild.id, suspectProfile.userID).catch(() => null)
    if (suspectCentroid && typeof altDB.findSimilarAuthorsByEmbedding === 'function') {
      const semMatches = await altDB.findSimilarAuthorsByEmbedding(
        guild.id,
        suspectProfile.userID,
        suspectCentroid,
        { limit: 10 }
      ).catch(() => [])
      for (const m of semMatches) {
        if (!m?.authorID || m.authorID === suspectProfile.userID) continue
        if (m.centroid) centroidByAuthor.set(m.authorID, m.centroid)
        if (!recentMsgsByAuthor.has(m.authorID)) {
          const hist = await altDB.getMemberMessages(guild.id, m.authorID, { limit: 40 }).catch(() => [])
          if (hist.length) recentMsgsByAuthor.set(m.authorID, hist)
        }
        if (!candidateMap.has(m.authorID)) {
          const prof = await altDB.getMemberProfile(guild.id, m.authorID).catch(() => null)
          candidateMap.set(m.authorID, prof || {
            userID: m.authorID,
            username: null,
            globalName: null,
            nick: null,
            avatarHash: null,
            avatarURL: null,
            accountCreatedAt: snowflakeToDate(m.authorID),
            joinedAt: null,
            inviteCode: null,
            status: 'active',
            statusAt: null,
            moderationReason: null
          })
        }
      }
    }
  }

  for (const authorID of recentMsgsByAuthor.keys()) {
    if (!candidateMap.has(authorID) && authorID !== suspectProfile.userID) {
      candidateMap.set(authorID, {
        userID: authorID,
        username: null,
        globalName: null,
        nick: null,
        avatarHash: null,
        avatarURL: null,
        accountCreatedAt: snowflakeToDate(authorID),
        joinedAt: null,
        inviteCode: null,
        status: 'active',
        statusAt: null,
        moderationReason: null
      })
    }
  }

  // Always load historical (including mod-deleted & self-deleted) messages of recent offenders
  // BEFORE ranking, so disguised alts with 0 name/avatar/timing similarity are still compared
  // against every recent offender's writing style and vocabulary.
  if (suspectMessages.length >= 1) {
    const missingOffenders = [...candidateMap.values()]
      .filter(p => MOD_STATUSES.has(p.status) && !recentMsgsByAuthor.has(p.userID))
      .sort((a, b) => (b.statusAt ? new Date(b.statusAt).getTime() : 0) - (a.statusAt ? new Date(a.statusAt).getTime() : 0))
      .slice(0, 25)
    const missingLeft = [...candidateMap.values()]
      .filter(p => p.status === 'left' && !recentMsgsByAuthor.has(p.userID))
      .sort((a, b) => (b.statusAt ? new Date(b.statusAt).getTime() : 0) - (a.statusAt ? new Date(a.statusAt).getTime() : 0))
      .slice(0, 5)
    for (const p of [...missingOffenders, ...missingLeft]) {
      const msgs = await altDB.getMemberMessages(guild.id, p.userID, { limit: 40 }).catch(() => [])
      if (msgs.length >= 1) recentMsgsByAuthor.set(p.userID, msgs)
    }
  }

  // First pass: score every candidate using profiles, messages, and any already-fetched centroids.
  const scored = []
  for (const [candidateID, candidateProfile] of candidateMap) {
    const msgs = recentMsgsByAuthor.get(candidateID) || []
    const candCentroid = centroidByAuthor.get(candidateID) || null
    const heuristic = scorePair({
      suspectProfile,
      candidateProfile,
      suspectMessages,
      candidateMessages: msgs,
      suspectCentroid: candCentroid ? suspectCentroid : null,
      candidateCentroid: candCentroid,
      now
    })
    scored.push({ candidateProfile, candidateMessages: msgs, heuristic })
  }

  scored.sort((a, b) => {
    if (b.heuristic.score !== a.heuristic.score) return b.heuristic.score - a.heuristic.score
    const aMod = MOD_STATUSES.has(a.candidateProfile.status) ? 1 : 0
    const bMod = MOD_STATUSES.has(b.candidateProfile.status) ? 1 : 0
    return bMod - aMod
  })

  // Optional pgvector semantic centroid boost + in-domain General Impostors statistical
  // calibration for top candidates (controls for server-specific slang/memes).
  const top = scored.slice(0, Math.max(limit, 8))
  if (suspectMessages.length >= 3) {
    let rescored = false
    for (const item of top.slice(0, 8)) {
      if (item.candidateMessages.length < 3) continue
      let candCentroid = centroidByAuthor.get(item.candidateProfile.userID) || null
      if (suspectCentroid && !centroidByAuthor.has(item.candidateProfile.userID)) {
        candCentroid = await altDB.getAuthorEmbeddingCentroid(guild.id, item.candidateProfile.userID).catch(() => null)
        if (candCentroid) centroidByAuthor.set(item.candidateProfile.userID, candCentroid)
      }
      const impostors = pickImpostorMessages(recentMsgsByAuthor, [suspectProfile.userID, item.candidateProfile.userID])
      if (candCentroid || impostors.length >= 3) {
        item.heuristic = scorePair({
          suspectProfile,
          candidateProfile: item.candidateProfile,
          suspectMessages,
          candidateMessages: item.candidateMessages,
          suspectCentroid: candCentroid ? suspectCentroid : null,
          candidateCentroid: candCentroid,
          impostorMessages: impostors.length >= 3 ? impostors : null,
          now
        })
        rescored = true
      }
    }
    if (rescored) {
      top.sort((a, b) => {
        if (b.heuristic.score !== a.heuristic.score) return b.heuristic.score - a.heuristic.score
        const aMod = MOD_STATUSES.has(a.candidateProfile.status) ? 1 : 0
        const bMod = MOD_STATUSES.has(b.candidateProfile.status) ? 1 : 0
        return bMod - aMod
      })
    }
  }

  return top.filter(item => item.heuristic.score > 0 || trigger === 'manual').slice(0, limit)
}

// --- Stage 2: Gemini precision verification ---

function formatDateIso (d) {
  if (!d) return '不明'
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return '不明'
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function statusLabelJa (status) {
  switch (status) {
    case 'banned': return 'BAN済み'
    case 'kicked': return 'キック済み'
    case 'restricted': return '違反者ロール付与'
    case 'left': return '退出済み'
    case 'active': return '在籍中'
    default: return '不明'
  }
}

function statusLabelEn (status) {
  switch (status) {
    case 'banned': return 'Banned'
    case 'kicked': return 'Kicked'
    case 'restricted': return 'Restricted (offender role)'
    case 'left': return 'Left'
    case 'active': return 'Active'
    default: return 'Unknown'
  }
}

function formatProfileBlock (profile) {
  const lines = [
    `ユーザーID: ${profile.userID}`,
    `ユーザー名: ${profile.username || '不明'}`,
    `表示名(globalName): ${profile.globalName || 'なし'}`,
    `サーバーニックネーム: ${profile.nick || 'なし'}`,
    `ステータス: ${statusLabelJa(profile.status)}`,
    `アカウント作成日時: ${formatDateIso(profile.accountCreatedAt)}`,
    `サーバー参加日時: ${formatDateIso(profile.joinedAt)}`,
    `使用招待コード: ${profile.inviteCode || '不明'}`,
    `カスタムアバター設定: ${profile.avatarHash ? 'あり' : 'デフォルト'}`
  ]
  if (profile.statusAt) lines.push(`ステータス更新日時: ${formatDateIso(profile.statusAt)}`)
  if (profile.moderationReason) lines.push(`BAN/キック理由: ${profile.moderationReason}`)
  return lines.join('\n')
}

function formatMessagesBlock (messages, source) {
  if (!Array.isArray(messages) || messages.length === 0) return '（保存された発言サンプルなし）'
  const sample = messages.slice(0, 25).map(m => {
    const ts = m.ts ? formatDateIso(m.ts) : '不明'
    let tag = ''
    if (m.deleted) {
      tag = m.deletedBy === 'moderator'
        ? '[モデレーター削除済み] '
        : (m.deletedBy === 'self' ? '[本人削除済み] ' : '[削除済み] ')
    } else if (m.editedBefore) {
      tag = '[編集前] '
    }
    const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return `[${ts}] ${tag}(ch:${m.channelID || '?'}) ${text}`
  }).join('\n')
  untrusted.reportInjection(`altDetector:${source}`, sample)
  return untrusted.wrap(source, sample)
}

function formatHeuristicBlock (heuristic) {
  const lines = [`総合ヒューリスティックスコア: ${heuristic.score} / 100`]
  if (heuristic.signals.length) {
    lines.push('検出された一致・疑わしいシグナル:')
    for (const s of heuristic.signals) lines.push(`- ${s}`)
  } else {
    lines.push('検出された一致シグナル: なし')
  }
  const m = heuristic.metrics || {}
  const statLines = []
  if (m.impostorsScore != null) statLines.push(`General Impostors 勝率: ${Math.round(m.impostorsScore * 100)}%（サーバー内インポスター ${m.impostorsCount}人比較）`)
  if (m.topicAgnosticGrammarSim != null) statLines.push(`話題非依存文法骨格 MinMax: ${Math.round(m.topicAgnosticGrammarSim * 100)}%`)
  if (m.functionWordSim != null) statLines.push(`日本語助詞・機能語 MinMax: ${Math.round(m.functionWordSim * 100)}%`)
  if (m.compressionSimilarity != null) statLines.push(`バランス圧縮文体類似度(COAV/NCD): ${Math.round(m.compressionSimilarity * 100)}%`)
  if (m.ietKsSimilarity != null) statLines.push(`投稿間隔分布(IET) KS類似度: ${Math.round(m.ietKsSimilarity * 100)}%`)
  if (m.hourSimilarity != null) statLines.push(`活動時間帯(JST) JSD類似度: ${Math.round(m.hourSimilarity * 100)}%`)
  if (m.embeddingSimilarity != null) statLines.push(`意味ベクトル重心コサイン類似度: ${Math.round(m.embeddingSimilarity * 100)}%`)
  if (statLines.length) {
    lines.push('計量文体・行動統計サマリー（話題・アバター・名前に非依存）:')
    for (const s of statLines) lines.push(`- ${s}`)
  }
  const anchors = []
  if (m.sharedTokens?.length) anchors.push(`共通固有語彙: ${m.sharedTokens.join(', ')}`)
  if (m.sharedEmojis?.length) anchors.push(`共通絵文字: ${m.sharedEmojis.join(' ')}`)
  if (m.sharedUrlDomains?.length) anchors.push(`共通外部リンク先: ${m.sharedUrlDomains.join(', ')}`)
  if (m.sharedMentionTargets?.length) anchors.push(`共通メンション対象ID: ${m.sharedMentionTargets.join(', ')}`)
  if (anchors.length) {
    lines.push('抽出された中身・行動アンカー（ユーザー由来データ）:')
    lines.push(untrusted.wrap('behavioral_anchors', anchors.join('\n')))
  }
  if (heuristic.counterSignals.length) {
    lines.push('反証・誤検知抑止シグナル:')
    for (const c of heuristic.counterSignals) lines.push(`- ${c}`)
  }
  return lines.join('\n')
}

function parseAiJson (rawText) {
  if (!rawText) return null
  let cleaned = String(rawText).trim()
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fenced) cleaned = fenced[1].trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (_) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch (_) {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const validVerdicts = new Set(['likely_alt', 'possible_alt', 'unlikely', 'insufficient'])
  const verdict = validVerdicts.has(parsed.verdict) ? parsed.verdict : 'insufficient'
  const confNum = Number(parsed.confidence)
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(100, Math.round(confNum))) : 0
  const summary = String(parsed.summary || '').trim().slice(0, 600)
  const matchingEvidence = Array.isArray(parsed.matching_evidence)
    ? parsed.matching_evidence.map(s => String(s || '').trim()).filter(Boolean).slice(0, 5)
    : []
  const counterEvidence = Array.isArray(parsed.counter_evidence)
    ? parsed.counter_evidence.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4)
    : []
  return { verdict, confidence, summary, matchingEvidence, counterEvidence }
}

async function fetchSingleAvatar (profile) {
  if (!profile?.avatarHash || !profile?.avatarURL) return null
  try {
    const img = await urlFetcher.fetchImage(profile.avatarURL)
    if (!img?.buffer) return null
    const mime = String(img.contentType || '').split(';')[0].trim() || 'image/png'
    return { inlineData: { mimeType: mime, data: img.buffer.toString('base64') } }
  } catch (_) {
    return null
  }
}

// Fetches whichever custom avatar(s) exist (both, only A, only B, or shared) so Gemini can
// perform cross-modal judgment (e.g., Account A's messages mentioning a specific creator/fandom
// linked to Account B's custom avatar, even when A uses a default avatar).
async function fetchAvatarsForAnalysis (suspectProfile, candidateProfile) {
  const sameHash = Boolean(
    suspectProfile?.avatarHash &&
    candidateProfile?.avatarHash &&
    suspectProfile.avatarHash === candidateProfile.avatarHash
  )
  if (sameHash) {
    const shared = await fetchSingleAvatar(suspectProfile) || await fetchSingleAvatar(candidateProfile)
    return shared ? { a: shared, b: null, sameHash: true } : null
  }
  const [a, b] = await Promise.all([
    fetchSingleAvatar(suspectProfile),
    fetchSingleAvatar(candidateProfile)
  ])
  if (!a && !b) return null
  return { a, b, sameHash: false }
}

async function analyzeWithGemini ({
  guildID,
  suspectProfile,
  candidateProfile,
  suspectMessages = [],
  candidateMessages = [],
  heuristic,
  background = false,
  fetchAvatars = true
}) {
  if (!isGatewayConfigured()) return null
  const avatars = fetchAvatars ? await fetchAvatarsForAnalysis(suspectProfile, candidateProfile) : null
  let avatarAttachmentNote = ''
  if (avatars) {
    if (avatars.sameHash) {
      avatarAttachmentNote = '上記のテキストに続き、調査対象 A と候補 B でハッシュ完全一致している共通アバター画像1枚を添付します（ありふれた汎用画像か、固有・ニッチなモチーフかも確認してください）。'
    } else if (avatars.a && avatars.b) {
      avatarAttachmentNote = '上記のテキストに続き、1枚目が調査対象 A のアバター画像、2枚目が候補 B のアバター画像です。'
    } else if (avatars.a) {
      avatarAttachmentNote = '上記のテキストに続き、調査対象 A のアバター画像（1枚のみ。候補 B はデフォルトまたは未取得）を添付します。候補 B の発言・プロフィール内容と調査対象 A のアイコンとのクロスモーダルな関連性を確認してください。'
    } else if (avatars.b) {
      avatarAttachmentNote = '上記のテキストに続き、候補 B のアバター画像（1枚のみ。調査対象 A はデフォルトまたは未取得）を添付します。調査対象 A の発言・プロフィール内容と候補 B のアイコンとのクロスモーダルな関連性を確認してください。'
    }
  }
  const promptText = prompts.render('alt/analyze', {
    heuristicSummary: formatHeuristicBlock(heuristic),
    suspectProfile: untrusted.wrap('suspect_profile', formatProfileBlock(suspectProfile)),
    candidateProfile: untrusted.wrap('candidate_profile', formatProfileBlock(candidateProfile)),
    suspectMessages: formatMessagesBlock(suspectMessages, 'suspect_messages'),
    candidateMessages: formatMessagesBlock(candidateMessages, 'candidate_messages'),
    avatarsAttached: Boolean(avatars),
    avatarAttachmentNote
  })
  const parts = [{ text: promptText }]
  if (avatars) {
    if (avatars.sameHash && avatars.a) {
      parts.push({ text: '調査対象 A・候補 B 共通のアバター画像:' }, avatars.a)
    } else {
      if (avatars.a) parts.push({ text: '調査対象 A のアバター画像:' }, avatars.a)
      if (avatars.b) parts.push({ text: '候補 B のアバター画像:' }, avatars.b)
    }
  }
  const { model, thinking, flex } = await resolveTaskConfig('light', guildID)
  const invoke = () => callGemini(model, {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: ALT_RESPONSE_SCHEMA,
      ...(avatars ? { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } : {}),
      ...thinking
    }
  }, {
    timeoutMs: 45 * 1000,
    purpose: 'altDetector',
    ...(background && flex ? { flex: true } : {})
  })

  try {
    const content = background
      ? await backgroundQueue.run(guildID, invoke)
      : await invoke()
    const rawText = (content?.parts || []).map(p => p.text || '').join('')
    return parseAiJson(rawText)
  } catch (e) {
    global.logger?.warn(`[ALT]: Gemini analysis failed for guild ${guildID}: ${e.message}`)
    return null
  }
}

// --- Alert rendering & delivery ---

function pickAlertEventName (guildSettings) {
  if (!guildSettings || typeof guildSettings.getEventByName !== 'function') return null
  for (const name of ALERT_EVENT_PRIORITY) {
    if (guildSettings.getEventByName(name)) return name
  }
  return null
}

function verdictLabel (verdict, lang = 'ja') {
  const map = lang === 'en'
    ? { likely_alt: '🔴 Likely alt account', possible_alt: '🟠 Possible alt account', unlikely: '🟢 Unlikely', insufficient: '⚪ Insufficient data' }
    : { likely_alt: '🔴 サブ垢の可能性が高い', possible_alt: '🟠 サブ垢の疑いあり（要確認）', unlikely: '🟢 別人の可能性が高い', insufficient: '⚪ 判断材料不足' }
  return map[verdict] || verdict
}

function triggerLabel (trigger, lang = 'ja') {
  const map = lang === 'en'
    ? { join: 'Member join (auto)', messages: 'Post-join messages (auto)', message: 'Post-join messages (auto)', manual: 'Manual check (/altcheck)' }
    : { join: '参加時自動検知', messages: '参加後発言の自動検知', message: '参加後発言の自動検知', manual: '手動調査 (/altcheck)' }
  return map[trigger] || trigger
}

function formatUserLine (profile, lang = 'ja') {
  const name = profile.username
    ? `${profile.username}${profile.globalName && profile.globalName !== profile.username ? ` (${profile.globalName})` : ''}`
    : (lang === 'en' ? 'Unknown' : '不明')
  const status = lang === 'en' ? statusLabelEn(profile.status) : statusLabelJa(profile.status)
  const createdTs = profile.accountCreatedAt ? `<t:${Math.floor(new Date(profile.accountCreatedAt).getTime() / 1000)}:R>` : (lang === 'en' ? 'Unknown' : '不明')
  const lines = [
    `<@${profile.userID}> — **${name}** (\`${profile.userID}\`)`,
    lang === 'en'
      ? `Status: **${status}** / Created: ${createdTs}`
      : `状態: **${status}** ／ アカウント作成: ${createdTs}`
  ]
  if (profile.moderationReason) {
    lines.push(lang === 'en' ? `Mod reason: ${profile.moderationReason}` : `処分理由: ${profile.moderationReason}`)
  }
  return lines.join('\n')
}

function buildAlertEmbed ({ suspectProfile, candidateProfile, heuristic, ai, trigger = 'join', lang = 'ja' }) {
  const verdict = ai?.verdict || 'possible_alt'
  const color = verdict === 'likely_alt'
    ? EMBED_COLORS.RED
    : (verdict === 'possible_alt' ? EMBED_COLORS.YELLOW_ORANGE : EMBED_COLORS.PURPLED_BLUE)
  const scoreLine = ai
    ? (lang === 'en'
        ? `${verdictLabel(verdict, lang)}\nAI Confidence: **${ai.confidence}%** / Heuristic Score: **${heuristic.score}/100**\nTrigger: ${triggerLabel(trigger, lang)}`
        : `${verdictLabel(verdict, lang)}\nAI 確信度: **${ai.confidence}%** ／ 第1段階スコア: **${heuristic.score}/100**\n検知契機: ${triggerLabel(trigger, lang)}`)
    : (lang === 'en'
        ? `${verdictLabel(verdict, lang)} (Heuristic only — AI unavailable)\nHeuristic Score: **${heuristic.score}/100**\nTrigger: ${triggerLabel(trigger, lang)}`
        : `${verdictLabel(verdict, lang)}（AI未接続のためルール判定のみ）\n第1段階スコア: **${heuristic.score}/100**\n検知契機: ${triggerLabel(trigger, lang)}`)

  const matching = (ai?.matchingEvidence?.length ? ai.matchingEvidence : heuristic.signals).slice(0, 5)
  const counter = [...(ai?.counterEvidence || []), ...heuristic.counterSignals]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 4)

  const fields = [
    {
      name: lang === 'en' ? 'Target account (A)' : '調査対象アカウント (A)',
      value: formatUserLine(suspectProfile, lang)
    },
    {
      name: lang === 'en' ? 'Candidate account (B)' : '一致候補アカウント (B)',
      value: formatUserLine(candidateProfile, lang)
    },
    {
      name: lang === 'en' ? 'Assessment' : '判定・スコア',
      value: scoreLine
    }
  ]
  if (ai?.summary) {
    fields.push({
      name: lang === 'en' ? 'AI Summary' : 'AI 所見',
      value: ai.summary
    })
  }
  if (matching.length) {
    fields.push({
      name: lang === 'en' ? 'Evidence' : '主な根拠',
      value: matching.map(s => `・${s}`).join('\n')
    })
  }
  if (counter.length) {
    fields.push({
      name: lang === 'en' ? 'Caveats / Counter-evidence' : '反証・誤検知への注意点',
      value: counter.map(s => `・${s}`).join('\n')
    })
  }

  return {
    title: lang === 'en' ? '⚠️ Alt-Account Alert (Staff Review Only)' : '⚠️ サブ垢検知アラート（要スタッフ確認）',
    color,
    description: lang === 'en'
      ? 'A potential alt account was detected. **No automatic punishment was taken** — please review the evidence below before acting.'
      : '同一人物のサブアカウント（BAN/キック回避等）の疑いが検知されました。**自動処罰は行っていません。** 下記の根拠・反証を確認のうえスタッフがご判断ください。',
    fields,
    footer: {
      text: lang === 'en'
        ? 'Alert only — no automatic kick/ban • /altcheck compare for details'
        : '通知のみ（自動処罰なし） • 詳細は /altcheck compare で確認できます'
    },
    timestamp: new Date()
  }
}

function canBotSendToChannel (guild, channelID) {
  if (!channelID) return false
  const ch = guild?.channels?.get?.(channelID) || null
  if (!ch) return true // channel not cached yet; let createMessage attempt it and fall back on error
  const botId = global.bot?.user?.id
  if (!botId || typeof ch.permissionsOf !== 'function') return true
  try {
    const perms = ch.permissionsOf(botId)
    if (!perms) return true
    const has = p => (typeof perms.has === 'function' ? perms.has(p) : Boolean(perms.json?.[p]))
    return has('viewChannel') && has('sendMessages')
  } catch (_) {
    return true
  }
}

async function fetchRestGuildModChannels (guildID) {
  if (!guildID || typeof global.bot?.requestHandler?.request !== 'function') return null
  const cached = guildModChannelCache.get(guildID)
  if (cached && cached.expiresAt > Date.now()) return cached
  try {
    const raw = await global.bot.requestHandler.request('GET', `/guilds/${guildID}`, true)
    const entry = {
      publicUpdatesChannelID: raw?.public_updates_channel_id || null,
      safetyAlertsChannelID: raw?.safety_alerts_channel_id || null,
      expiresAt: Date.now() + MOD_CHANNEL_CACHE_TTL_MS
    }
    guildModChannelCache.set(guildID, entry)
    return entry
  } catch (_) {
    const entry = { publicUpdatesChannelID: null, safetyAlertsChannelID: null, expiresAt: Date.now() + 60 * 1000 }
    guildModChannelCache.set(guildID, entry)
    return entry
  }
}

// Resolves where automatic alt-account alerts should be posted by reading Discord's Server
// Settings first:
//   1. Community -> Overview -> Moderator-only / Community Updates channel (public_updates_channel_id)
//   2. Safety Setup -> Safety Alerts channel (safety_alerts_channel_id)
//   3. Fallback: RoboPolice's configured staff log channel (for non-Community servers)
async function resolveAlertDestination (guild) {
  if (!guild?.id) return null

  const tryModChannel = (channelID, source) => {
    if (!channelID) return null
    if (!canBotSendToChannel(guild, channelID)) return null
    return { kind: 'mod_channel', channelID, source }
  }

  const fromPublic = tryModChannel(guild.publicUpdatesChannelID, 'public_updates')
  if (fromPublic) return fromPublic

  const fromSafetyDirect = tryModChannel(guild.safetyAlertsChannelID, 'safety_alerts')
  if (fromSafetyDirect) return fromSafetyDirect

  const restMod = await fetchRestGuildModChannels(guild.id)
  if (restMod) {
    const restPublic = tryModChannel(restMod.publicUpdatesChannelID, 'public_updates')
    if (restPublic) return restPublic
    const restSafety = tryModChannel(restMod.safetyAlertsChannelID, 'safety_alerts')
    if (restSafety) return restSafety
  }

  let guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  if (!guildSettings && global.bot) {
    await cacheGuild(guild.id).catch(() => {})
    guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  }
  const eventName = pickAlertEventName(guildSettings)
  if (!eventName) return null
  const channelID = guildSettings?.getEventByName?.(eventName) || null
  return { kind: 'log_webhook', channelID, eventName, source: 'log_channel' }
}

async function sendAltAlert (guild, { suspectProfile, candidateProfile, heuristic, ai, trigger }) {
  const verdict = ai?.verdict || 'possible_alt'
  const summary = ai?.summary || heuristic.signals.join(' / ').slice(0, 400)
  const signals = ai?.matchingEvidence?.length ? ai.matchingEvidence : heuristic.signals
  await altDB.recordAlert(guild.id, {
    suspectUserID: suspectProfile.userID,
    candidateUserID: candidateProfile.userID,
    trigger,
    heuristicScore: heuristic.score,
    aiConfidence: ai ? ai.confidence : null,
    verdict,
    summary,
    signals
  }).catch(e => global.logger?.warn(`[ALT]: Failed to record alert in guild ${guild.id}: ${e.message}`))

  const dest = await resolveAlertDestination(guild)
  if (!dest) return { sent: false, reason: 'no_alert_channel' }

  const embed = buildAlertEmbed({ suspectProfile, candidateProfile, heuristic, ai, trigger, lang: 'ja' })
  if (dest.kind === 'mod_channel' && typeof global.bot?.createMessage === 'function') {
    try {
      await global.bot.createMessage(dest.channelID, {
        embeds: [embed],
        allowedMentions: { everyone: false, roles: false, users: false }
      })
      return { sent: true, channelID: dest.channelID, source: dest.source, embed }
    } catch (e) {
      global.logger?.warn(`[ALT]: Failed to post alert to mod channel ${dest.channelID} in guild ${guild.id}: ${e.message}`)
      // Fall back to configured log channel webhook if available
      let guildSettings = global.bot?.guildSettingsCache?.[guild.id]
      if (!guildSettings && global.bot) {
        await cacheGuild(guild.id).catch(() => {})
        guildSettings = global.bot?.guildSettingsCache?.[guild.id]
      }
      const fallbackEvent = pickAlertEventName(guildSettings)
      if (!fallbackEvent) return { sent: false, reason: 'mod_channel_send_failed' }
      await send({ guildID: guild.id, eventName: fallbackEvent, embeds: [embed] })
      return { sent: true, eventName: fallbackEvent, source: 'log_channel', embed }
    }
  }

  if (dest.kind === 'log_webhook') {
    await send({ guildID: guild.id, eventName: dest.eventName, embeds: [embed] })
    return { sent: true, eventName: dest.eventName, channelID: dest.channelID, source: dest.source, embed }
  }
  return { sent: false, reason: 'no_alert_channel' }
}

function shouldAlertFromResult ({ ai, heuristic, candidateProfile }) {
  if (ai) {
    return (ai.verdict === 'likely_alt' || ai.verdict === 'possible_alt') && ai.confidence >= alertConfidence()
  }
  // Fallback when AI is not configured or temporarily unavailable: only alert on very strong
  // deterministic BAN/kick evasion evidence so we avoid false positives.
  return MOD_STATUSES.has(candidateProfile?.status) && heuristic.score >= 70
}

// --- Automatic event hooks ---

async function onMemberBan (guild, user, { reason = null, at = new Date() } = {}) {
  if (!guild?.id || !user?.id || user.bot) return
  await altDB.markMemberStatus(guild.id, user.id, 'banned', {
    reason: reason || null,
    at,
    profile: profileFromUser(user) || { userID: user.id }
  })
}

async function onMemberLeave (guild, member, { kicked = false, reason = null, at = new Date() } = {}) {
  if (!guild?.id || !member) return
  const userID = member.id || member.user?.id
  if (!userID || member.bot || member.user?.bot) return
  const restricted = hasOffenderRole(member)
  const status = kicked ? 'kicked' : (restricted ? 'restricted' : 'left')
  const effectiveReason = reason || (status === 'restricted' ? '違反者ロール付与のまま退出' : null)
  await altDB.markMemberStatus(guild.id, userID, status, {
    reason: effectiveReason,
    at,
    profile: profileFromMember(member) || { userID }
  })
}

async function onMemberUpdate (guild, member, oldMember, { at = new Date() } = {}) {
  if (!guild?.id || !member) return { updated: false }
  const userID = member.id || member.user?.id
  if (!userID || member.bot || member.user?.bot) return { updated: false }
  const hadOffender = oldMember ? hasOffenderRole(oldMember) : null
  const hasOffender = hasOffenderRole(member)

  if (hasOffender && hadOffender !== true) {
    if (hadOffender === null) {
      const existing = await altDB.getMemberProfile(guild.id, userID).catch(() => null)
      if (existing?.status === 'restricted') return { updated: false }
    }
    await altDB.markMemberStatus(guild.id, userID, 'restricted', {
      reason: '違反者ロール付与',
      at,
      profile: profileFromMember(member, { status: 'restricted' }) || { userID }
    })
    return { updated: true, status: 'restricted' }
  }

  if (!hasOffender && hadOffender === true) {
    await altDB.markMemberStatus(guild.id, userID, 'active', {
      reason: null,
      at,
      profile: profileFromMember(member, { status: 'active' }) || { userID }
    })
    return { updated: true, status: 'active' }
  }
  return { updated: false }
}

async function onMemberJoin (guild, member, { inviteCode = null, now = new Date() } = {}) {
  if (!guild?.id || !member) return { checked: false }
  const user = member.user || member
  if (member.bot || user?.bot) return { checked: false }
  const initialStatus = hasOffenderRole(member) ? 'restricted' : 'active'
  const profile = profileFromMember(member, {
    joinedAt: member.joinedAt ? new Date(member.joinedAt) : now,
    inviteCode: inviteCode || null,
    status: initialStatus,
    statusAt: now
  })
  if (!profile) return { checked: false }

  await altDB.upsertMemberProfile(guild.id, profile).catch(e => {
    global.logger?.warn(`[ALT]: Failed to upsert join profile for ${profile.userID} in ${guild.id}: ${e.message}`)
  })

  if (!isGlobalEnabled()) return { checked: false }
  if (!(await altDB.isAltDetectionEnabled(guild.id))) return { checked: false }

  const candidates = await findCandidates(guild, profile, [], { trigger: 'join', now, limit: 3 })
  if (!candidates.length) return { checked: true, alerted: false }

  // Cost guard: evaluate only the #1 candidate on join (plus #2 only if it has a very high
  // direct score >= 65), and enforce the per-guild daily automatic AI budget cap.
  const toCheck = candidates.slice(0, 2).filter((c, idx) => idx === 0 || c.heuristic.score >= 65)
  for (const cand of toCheck) {
    const threshold = joinAiThreshold(MOD_STATUSES.has(cand.candidateProfile.status))
    if (cand.heuristic.score < threshold) continue
    if (await altDB.hasRecentAlert(guild.id, profile.userID, cand.candidateProfile.userID, alertCooldownHours())) continue

    let ai = null
    if (consumeAutoAiBudget(guild.id, now)) {
      let candMsgs = cand.candidateMessages
      if (!candMsgs || candMsgs.length === 0) {
        candMsgs = await altDB.getMemberMessages(guild.id, cand.candidateProfile.userID, { limit: 40 }).catch(() => [])
      }
      ai = await analyzeWithGemini({
        guildID: guild.id,
        suspectProfile: profile,
        candidateProfile: cand.candidateProfile,
        suspectMessages: [],
        candidateMessages: candMsgs,
        heuristic: cand.heuristic,
        background: true
      })
    }
    if (shouldAlertFromResult({ ai, heuristic: cand.heuristic, candidateProfile: cand.candidateProfile })) {
      const delivery = await sendAltAlert(guild, {
        suspectProfile: profile,
        candidateProfile: cand.candidateProfile,
        heuristic: cand.heuristic,
        ai,
        trigger: 'join'
      })
      return { checked: true, alerted: true, candidate: cand, ai, delivery }
    }
  }
  return { checked: true, alerted: false, candidates }
}

function bumpMessageCounter (guildID, userID) {
  const key = `${guildID}:${userID}`
  let entry = messageCounters.get(key)
  if (!entry) {
    if (messageCounters.size >= MAX_COUNTER_ENTRIES) {
      const oldestKey = messageCounters.keys().next().value
      messageCounters.delete(oldestKey)
    }
    entry = { count: 0, checked: new Set() }
    messageCounters.set(key, entry)
  }
  entry.count++
  return entry
}

function findRecentCrossDeleteMatch (guildID, authorID, content, now = new Date()) {
  const list = recentDeletedByGuild.get(guildID)
  if (!list || !list.length) return null
  const nowMs = now.getTime()
  let best = null
  for (let i = list.length - 1; i >= 0; i--) {
    const del = list[i]
    if (!del || del.authorID === authorID) continue
    const delta = nowMs - del.deletedTs.getTime()
    if (delta < -30 * 1000 || delta > CROSS_DELETE_REPOST_WINDOW_MS) continue
    const sim = repostTextSimilarity(del.content, content)
    if (sim >= 0.75 && (!best || sim > best.similarity)) {
      best = { entry: del, similarity: sim, deltaMs: Math.max(0, delta) }
    }
  }
  return best
}

function recordAuditDeleteCount (key, count) {
  if (lastModDeleteCounts.has(key)) lastModDeleteCounts.delete(key)
  if (lastModDeleteCounts.size >= MAX_AUDIT_COUNT_ENTRIES) {
    const oldest = lastModDeleteCounts.keys().next().value
    lastModDeleteCounts.delete(oldest)
  }
  lastModDeleteCounts.set(key, count)
}

// Determines whether a single message deletion was performed by a moderator (Discord audit log
// MESSAGE_DELETE, actionType 72) or by the author themselves (no audit log entry is emitted when
// users delete their own messages). Handles Discord's extra.count batching for repeat mod deletes.
async function detectDeletionActorFromAuditLog (guild, { authorID, channelID = null, at = new Date() } = {}) {
  if (!guild || !authorID || typeof guild.getAuditLog !== 'function') {
    return { deletedBy: 'unknown', moderatorID: null }
  }
  const canViewAudit = guild.members?.get?.(global.bot?.user?.id)?.permissions?.has?.('viewAuditLog') !== false
  if (!canViewAudit) return { deletedBy: 'unknown', moderatorID: null }

  const logs = await guild.getAuditLog({ limit: 5, actionType: 72 }).catch(() => null)
  if (!logs || !Array.isArray(logs.entries)) return { deletedBy: 'unknown', moderatorID: null }

  const atMs = at instanceof Date ? at.getTime() : new Date(at).getTime()
  for (const e of logs.entries) {
    if (!e || e.targetID !== authorID) continue
    const entryChannelID = e.extra?.channel?.id || e.options?.channel_id || e.channelID || null
    if (channelID && entryChannelID && entryChannelID !== channelID) continue
    const count = Math.max(1, Number(e.extra?.count ?? e.options?.count ?? 1) || 1)
    const key = `${guild.id}:${e.id}`
    const prevCount = lastModDeleteCounts.get(key)
    const entryTs = snowflakeToDate(e.id)?.getTime()
    const isFresh = entryTs != null && Math.abs(atMs - entryTs) < 20 * 1000
    const isCountIncrement = prevCount !== undefined && count > prevCount
    const isFirstSeenFresh = prevCount === undefined && isFresh

    if (isCountIncrement || isFirstSeenFresh) {
      recordAuditDeleteCount(key, count)
      const modID = e.user?.id || e.userID || null
      if (modID && modID === authorID) {
        return { deletedBy: 'self', moderatorID: null }
      }
      return { deletedBy: 'moderator', moderatorID: modID }
    }
    if (prevCount === undefined) recordAuditDeleteCount(key, count)
  }
  return { deletedBy: 'self', moderatorID: null }
}

async function onMessageDelete (message, cachedMessage = null, { at = new Date(), auditDelayMs = 800 } = {}) {
  if (!message?.id) return { saved: false }
  const seen = recentSeenMessages.get(message.id) || null
  recentSeenMessages.delete(message.id)

  const guildID = cachedMessage?.guild_id || seen?.guildID || message.channel?.guild?.id || message.guildID || message.guildId || null
  const authorID = cachedMessage?.author_id || seen?.authorID || message.author?.id || null
  const channelID = cachedMessage?.channel_id || seen?.channelID || message.channel?.id || message.channelID || null
  const content = String(cachedMessage?.content || seen?.content || message.content || '').trim()
  const isBot = Boolean(message.author?.bot)
  if (isBot) return { saved: false }

  const guild = message.channel?.guild || (guildID ? global.bot?.guilds?.get?.(guildID) : null)
  const applyActor = async (targetGuildID, targetMsgID, targetAuthorID, targetChannelID, memRecord) => {
    const targetGuild = guild || (targetGuildID ? global.bot?.guilds?.get?.(targetGuildID) : null)
    const actor = await detectDeletionActorFromAuditLog(targetGuild, {
      authorID: targetAuthorID,
      channelID: targetChannelID,
      at
    })
    if (memRecord) {
      memRecord.deletedBy = actor.deletedBy
      memRecord.moderatorID = actor.moderatorID
    }
    if (actor.deletedBy !== 'unknown') {
      await altDB.updateSnapshotDeletionActor(targetGuildID, targetMsgID, actor).catch(() => {})
    }
    return actor
  }

  const scheduleOrRunActor = async (targetGuildID, targetMsgID, targetAuthorID, targetChannelID, memRecord) => {
    if (auditDelayMs <= 0) {
      return applyActor(targetGuildID, targetMsgID, targetAuthorID, targetChannelID, memRecord)
    }
    const timer = setTimeout(() => {
      applyActor(targetGuildID, targetMsgID, targetAuthorID, targetChannelID, memRecord).catch(() => {})
    }, auditDelayMs)
    timer.unref?.()
    return { deletedBy: 'unknown', moderatorID: null }
  }

  if (guildID && authorID && content) {
    const origRaw = cachedMessage?.ts || seen?.ts || message.timestamp || null
    const originalTs = origRaw ? new Date(origRaw) : null
    const memRecord = rememberDeletedMessage(guildID, {
      id: message.id,
      authorID,
      channelID,
      content,
      originalTs,
      deletedTs: at,
      deletedBy: 'unknown'
    }, at)
    await altDB.recordMessageSnapshot(guildID, {
      messageID: message.id,
      authorID,
      channelID,
      eventType: 'deleted',
      deletedBy: 'unknown',
      content,
      originalTs,
      eventTs: at
    }).catch(e => global.logger?.warn?.(`[ALT]: recordMessageSnapshot(delete) failed: ${e.message}`))
    const actor = await scheduleOrRunActor(guildID, message.id, authorID, channelID, memRecord)
    return { saved: true, guildID, authorID, deletedBy: actor.deletedBy, moderatorID: actor.moderatorID }
  }

  // Fallback for messages not in memory (e.g. older messages in ignored channels): copy from DB
  // right before `deleteMessage` removes the row.
  const copied = await altDB.snapshotMessagesBeforeDelete([message.id], { deletedBy: 'unknown', eventTs: at }).catch(() => [])
  let lastActor = { deletedBy: 'unknown', moderatorID: null }
  for (const row of copied) {
    const memRecord = rememberDeletedMessage(row.guildID, {
      id: row.id,
      authorID: row.authorID,
      channelID: row.channelID,
      content: row.content,
      originalTs: row.ts,
      deletedTs: at,
      deletedBy: 'unknown'
    }, at)
    lastActor = await scheduleOrRunActor(row.guildID, row.id, row.authorID, row.channelID, memRecord)
  }
  return { saved: copied.length > 0, copied: copied.length, deletedBy: lastActor.deletedBy, moderatorID: lastActor.moderatorID }
}

async function onMessageDeleteBulk (messages, { at = new Date() } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { saved: 0 }
  const ids = messages.map(m => m?.id).filter(Boolean)
  let saved = 0

  // Bulk deletion requires Manage Messages (moderator purge / BAN message delete), so classify as moderator.
  const copied = await altDB.snapshotMessagesBeforeDelete(ids, { deletedBy: 'moderator', eventTs: at }).catch(() => [])
  const copiedIds = new Set()
  for (const row of copied) {
    copiedIds.add(row.id)
    saved++
    rememberDeletedMessage(row.guildID, {
      id: row.id,
      authorID: row.authorID,
      channelID: row.channelID,
      content: row.content,
      originalTs: row.ts,
      deletedTs: at,
      deletedBy: 'moderator'
    }, at)
  }

  // Also capture messages still only in our in-memory ring buffer (e.g. ignored channels or
  // deleted before messageBatcher flushed).
  for (const m of messages) {
    if (!m?.id || copiedIds.has(m.id)) continue
    const seen = recentSeenMessages.get(m.id) || null
    recentSeenMessages.delete(m.id)
    if (m.author?.bot) continue
    const guildID = seen?.guildID || m.channel?.guild?.id || m.guildID || m.guildId || null
    const authorID = seen?.authorID || m.author?.id || null
    const channelID = seen?.channelID || m.channel?.id || m.channelID || null
    const content = String(seen?.content || m.content || '').trim()
    if (!guildID || !authorID || !content) continue
    const originalTs = seen?.ts || (m.timestamp ? new Date(m.timestamp) : null)
    rememberDeletedMessage(guildID, {
      id: m.id,
      authorID,
      channelID,
      content,
      originalTs,
      deletedTs: at,
      deletedBy: 'moderator'
    }, at)
    const ok = await altDB.recordMessageSnapshot(guildID, {
      messageID: m.id,
      authorID,
      channelID,
      eventType: 'deleted',
      deletedBy: 'moderator',
      content,
      originalTs,
      eventTs: at
    }).catch(() => false)
    if (ok) saved++
  }
  return { saved }
}

async function onMessageEdit (newMessage, oldMessage = null, { at = new Date() } = {}) {
  if (!newMessage?.id || newMessage.author?.bot) return { saved: false }
  const guildID = newMessage.channel?.guild?.id || newMessage.guildID || null
  const authorID = newMessage.author?.id || oldMessage?.author_id || oldMessage?.author?.id || null
  const channelID = newMessage.channel?.id || oldMessage?.channel_id || null
  if (!guildID || !authorID) return { saved: false }

  const seen = recentSeenMessages.get(newMessage.id) || null
  const oldContent = String(oldMessage?.content || seen?.content || '').trim()
  const newContent = String(newMessage.content || '').trim()

  if (newContent) {
    rememberSeenMessage({
      id: newMessage.id,
      guildID,
      authorID,
      channelID,
      content: newContent,
      ts: seen?.ts || (newMessage.timestamp ? new Date(newMessage.timestamp) : at)
    })
  }

  if (!oldContent || oldContent === newContent) return { saved: false }
  const origRaw = oldMessage?.ts || seen?.ts || newMessage.timestamp || null
  const originalTs = origRaw ? new Date(origRaw) : null
  const saved = await altDB.recordMessageSnapshot(guildID, {
    messageID: newMessage.id,
    authorID,
    channelID,
    eventType: 'edited',
    content: oldContent,
    originalTs,
    eventTs: at
  }).catch(e => {
    global.logger?.warn?.(`[ALT]: recordMessageSnapshot(edit) failed: ${e.message}`)
    return false
  })
  return { saved: Boolean(saved) }
}

async function onMessage (message, { now = new Date() } = {}) {
  const guild = message?.channel?.guild
  const guildID = guild?.id || message?.guildID
  if (!guildID || !message?.author?.id || message.author.bot) return { checked: false }
  const content = String(message.content || '').trim()
  if (!content) return { checked: false }

  // Always cache recently seen non-bot messages in memory so subsequent deletions/edits
  // (including mod-deleted dangerous words and self-deletes in ignored channels) are captured.
  rememberSeenMessage({
    id: message.id || `live-${now.getTime()}`,
    guildID,
    authorID: message.author.id,
    channelID: message.channel?.id || null,
    content,
    ts: message.timestamp ? new Date(message.timestamp) : now
  })

  if (!isGlobalEnabled()) return { checked: false }

  const resolvedGuild = guild || global.bot?.guilds?.get?.(guildID)

  // Real-time anti-evasion check: if another account's message was just deleted (by self or mod)
  // within 10m and this account reposted near-identical text, verify immediately.
  const crossMatch = findRecentCrossDeleteMatch(guildID, message.author.id, content, now)
  if (crossMatch && resolvedGuild && (await altDB.isAltDetectionEnabled(guildID))) {
    const candID = crossMatch.entry.authorID
    if (!(await altDB.hasRecentAlert(guildID, message.author.id, candID, alertCooldownHours()))) {
      const [suspectProfile, candidateProfile, dbSuspectMsgs, dbCandMsgs] = await Promise.all([
        resolveProfile(resolvedGuild, message.author.id),
        resolveProfile(resolvedGuild, candID),
        altDB.getMemberMessages(guildID, message.author.id, { limit: 40 }).catch(() => []),
        altDB.getMemberMessages(guildID, candID, { limit: 40 }).catch(() => [])
      ])
      const liveMsg = {
        id: message.id || `live-${now.getTime()}`,
        authorID: message.author.id,
        channelID: message.channel?.id || null,
        content,
        ts: message.timestamp ? new Date(message.timestamp) : now,
        deleted: false,
        deletedBy: null,
        editedBefore: false,
        eventTs: null
      }
      const deletedMsg = {
        id: `${crossMatch.entry.id || 'del'}:deleted`,
        authorID: candID,
        channelID: crossMatch.entry.channelID,
        content: crossMatch.entry.content,
        ts: crossMatch.entry.originalTs,
        deleted: true,
        deletedBy: crossMatch.entry.deletedBy || 'unknown',
        moderatorID: crossMatch.entry.moderatorID || null,
        editedBefore: false,
        eventTs: crossMatch.entry.deletedTs
      }
      const suspectMessages = mergeMessageLists([liveMsg], dbSuspectMsgs, 40)
      const candidateMessages = mergeMessageLists([deletedMsg], dbCandMsgs, 40)
      const heuristic = scorePair({ suspectProfile, candidateProfile, suspectMessages, candidateMessages, now })
      const ai = consumeAutoAiBudget(guildID, now)
        ? await analyzeWithGemini({
          guildID,
          suspectProfile,
          candidateProfile,
          suspectMessages,
          candidateMessages,
          heuristic,
          background: true
        })
        : null
      if (shouldAlertFromResult({ ai, heuristic, candidateProfile })) {
        const delivery = await sendAltAlert(resolvedGuild, {
          suspectProfile,
          candidateProfile,
          heuristic,
          ai,
          trigger: 'messages'
        })
        return { checked: true, alerted: true, reason: 'cross_delete_repost', candidate: { candidateProfile, heuristic }, ai, delivery }
      }
      return { checked: true, alerted: false, reason: 'cross_delete_repost', heuristic, ai }
    }
  }

  if (!(await altDB.isAltDetectionEnabled(guildID))) return { checked: false }

  const member = message.member
  const watchMs = messageWatchDays() * 86400 * 1000
  const isOlderMember = Boolean(member?.joinedAt && (now.getTime() - new Date(member.joinedAt).getTime()) > watchMs)
  const milestones = isOlderMember ? SLEEPER_CHECK_MILESTONES : MESSAGE_MILESTONES

  const entry = bumpMessageCounter(guildID, message.author.id)
  if (!milestones.includes(entry.count) || entry.checked.has(entry.count)) {
    return { checked: false }
  }

  // For accounts that joined longer than messageWatchDays() ago ("sleeper" alts), only run
  // automatic behavioral checks when the server has a recent banned/kicked/restricted offender.
  if (isOlderMember) {
    const hasOffender = typeof altDB.hasRecentOffender === 'function'
      ? await altDB.hasRecentOffender(guildID, { days: 30 }).catch(() => false)
      : false
    if (!hasOffender) return { checked: false }
  }
  entry.checked.add(entry.count)

  if (!resolvedGuild) return { checked: false }

  const suspectProfile = await resolveProfile(resolvedGuild, message.author.id)
  if (!isOlderMember && suspectProfile.joinedAt) {
    const joinedAgeMs = now.getTime() - new Date(suspectProfile.joinedAt).getTime()
    if (joinedAgeMs > watchMs) {
      const hasOffender = typeof altDB.hasRecentOffender === 'function'
        ? await altDB.hasRecentOffender(guildID, { days: 30 }).catch(() => false)
        : false
      if (!hasOffender || !SLEEPER_CHECK_MILESTONES.includes(entry.count)) return { checked: false }
    }
  }

  const storedMsgs = await altDB.getMemberMessages(guildID, message.author.id, { limit: 40 }).catch(() => [])
  const hasCurrent = storedMsgs.some(m => m.id === message.id)
  const suspectMessages = hasCurrent
    ? storedMsgs
    : [{
        id: message.id || `live-${now.getTime()}`,
        authorID: message.author.id,
        channelID: message.channel?.id || null,
        content,
        ts: message.timestamp ? new Date(message.timestamp) : now
      }, ...storedMsgs]

  if (suspectMessages.length < 3) return { checked: true, alerted: false }

  const candidates = await findCandidates(resolvedGuild, suspectProfile, suspectMessages, { trigger: 'messages', now, limit: 3 })
  if (!candidates.length) return { checked: true, alerted: false }

  const threshold = messageAiThreshold()
  for (const cand of candidates.slice(0, 2)) {
    if (cand.heuristic.score < threshold) continue
    if (await altDB.hasRecentAlert(guildID, suspectProfile.userID, cand.candidateProfile.userID, alertCooldownHours())) continue

    const ai = consumeAutoAiBudget(guildID, now)
      ? await analyzeWithGemini({
        guildID,
        suspectProfile,
        candidateProfile: cand.candidateProfile,
        suspectMessages,
        candidateMessages: cand.candidateMessages,
        heuristic: cand.heuristic,
        background: true
      })
      : null
    if (shouldAlertFromResult({ ai, heuristic: cand.heuristic, candidateProfile: cand.candidateProfile })) {
      const delivery = await sendAltAlert(resolvedGuild, {
        suspectProfile,
        candidateProfile: cand.candidateProfile,
        heuristic: cand.heuristic,
        ai,
        trigger: 'messages'
      })
      return { checked: true, alerted: true, candidate: cand, ai, delivery }
    }
  }
  return { checked: true, alerted: false, candidates }
}

// --- Manual moderator investigations (/altcheck) ---

async function investigateUser (guild, userID, { now = new Date(), fetchLiveChannels = true } = {}) {
  const [baseProfile, dbMessages, liveScan] = await Promise.all([
    resolveProfile(guild, userID),
    altDB.getMemberMessages(guild.id, userID, { limit: 50 }).catch(() => []),
    fetchLiveChannels
      ? fetchAllGuildChannelMessages(guild)
      : Promise.resolve({ byAuthor: new Map(), authors: new Map(), channelsScanned: 0, totalMessages: 0 })
  ])
  const liveAuthor = liveScan.authors.get(userID) || null
  const suspectProfile = liveAuthor ? mergeProfiles(baseProfile, liveAuthor) : baseProfile
  const suspectMessages = mergeMessageLists(dbMessages, liveScan.byAuthor.get(userID) || [], 60)
  const candidates = await findCandidates(guild, suspectProfile, suspectMessages, {
    trigger: 'manual',
    now,
    limit: 5,
    liveMessagesByAuthor: liveScan.byAuthor,
    liveAuthors: liveScan.authors
  })
  const topCandidate = candidates[0] || null
  let ai = null
  if (topCandidate && topCandidate.heuristic.score >= 15) {
    let candMsgs = topCandidate.candidateMessages
    if (!candMsgs || candMsgs.length === 0) {
      candMsgs = await altDB.getMemberMessages(guild.id, topCandidate.candidateProfile.userID, { limit: 40 }).catch(() => [])
    }
    ai = await analyzeWithGemini({
      guildID: guild.id,
      suspectProfile,
      candidateProfile: topCandidate.candidateProfile,
      suspectMessages,
      candidateMessages: candMsgs,
      heuristic: topCandidate.heuristic,
      background: false
    })
  }
  return {
    suspectProfile,
    suspectMessageCount: suspectMessages.length,
    channelsScanned: liveScan.channelsScanned,
    candidates,
    topCandidate,
    ai
  }
}

async function compareUsers (guild, userID1, userID2, { now = new Date(), fetchLiveChannels = true } = {}) {
  const [baseSuspect, baseCandidate, dbSuspectMsgs, dbCandidateMsgs, liveScan] = await Promise.all([
    resolveProfile(guild, userID1),
    resolveProfile(guild, userID2),
    altDB.getMemberMessages(guild.id, userID1, { limit: 50 }).catch(() => []),
    altDB.getMemberMessages(guild.id, userID2, { limit: 50 }).catch(() => []),
    fetchLiveChannels
      ? fetchAllGuildChannelMessages(guild)
      : Promise.resolve({ byAuthor: new Map(), authors: new Map(), channelsScanned: 0, totalMessages: 0 })
  ])
  const suspectProfile = liveScan.authors.get(userID1) ? mergeProfiles(baseSuspect, liveScan.authors.get(userID1)) : baseSuspect
  const candidateProfile = liveScan.authors.get(userID2) ? mergeProfiles(baseCandidate, liveScan.authors.get(userID2)) : baseCandidate
  const suspectMessages = mergeMessageLists(dbSuspectMsgs, liveScan.byAuthor.get(userID1) || [], 60)
  const candidateMessages = mergeMessageLists(dbCandidateMsgs, liveScan.byAuthor.get(userID2) || [], 60)

  let suspectCentroid = null
  let candidateCentroid = null
  let impostors = null
  if (suspectMessages.length >= 3 && candidateMessages.length >= 3) {
    const [cA, cB, dbRecent] = await Promise.all([
      altDB.getAuthorEmbeddingCentroid(guild.id, userID1).catch(() => null),
      altDB.getAuthorEmbeddingCentroid(guild.id, userID2).catch(() => null),
      altDB.getRecentAuthorsMessages(guild.id, '', { authorLimit: 20, perAuthor: 25, days: 30 }).catch(() => new Map())
    ])
    suspectCentroid = cA
    candidateCentroid = cB
    const impostorMap = new Map(dbRecent)
    for (const [authorID, liveMsgs] of liveScan.byAuthor) {
      if (authorID === userID1 || authorID === userID2) continue
      const merged = mergeMessageLists(impostorMap.get(authorID) || [], liveMsgs, 30)
      if (merged.length) impostorMap.set(authorID, merged)
    }
    const picked = pickImpostorMessages(impostorMap, [userID1, userID2])
    if (picked.length >= 3) impostors = picked
  }
  const heuristic = scorePair({
    suspectProfile,
    candidateProfile,
    suspectMessages,
    candidateMessages,
    suspectCentroid,
    candidateCentroid,
    impostorMessages: impostors,
    now
  })
  const ai = await analyzeWithGemini({
    guildID: guild.id,
    suspectProfile,
    candidateProfile,
    suspectMessages,
    candidateMessages,
    heuristic,
    background: false
  })
  return {
    suspectProfile,
    candidateProfile,
    suspectMessageCount: suspectMessages.length,
    candidateMessageCount: candidateMessages.length,
    channelsScanned: liveScan.channelsScanned,
    heuristic,
    ai
  }
}

// Scans the server for suspicious alt-account pairs (BAN/kick/offender evasion and/or same-person
// existing members) across both stored DB history and all live readable guild channels. Stage 1
// runs in memory at zero AI cost; Stage 2 Gemini analysis runs on the top suspicious pair(s).
async function scanServer (guild, { scope = 'all', limit = 5, aiVerifyTop = 2, minScore = 25, now = new Date(), fetchLiveChannels = true } = {}) {
  const [stored, dbRecentMsgsByAuthor, liveScan] = await Promise.all([
    altDB.getCandidateProfiles(guild.id, '', { limit: 200 }).catch(() => []),
    altDB.getRecentAuthorsMessages(guild.id, '', {
      authorLimit: 60,
      perAuthor: 30,
      days: 30
    }).catch(() => new Map()),
    fetchLiveChannels
      ? fetchAllGuildChannelMessages(guild)
      : Promise.resolve({ byAuthor: new Map(), authors: new Map(), channelsScanned: 0, totalMessages: 0 })
  ])

  const profileMap = new Map()
  for (const p of stored) {
    if (p?.userID) profileMap.set(p.userID, p)
  }

  if (guild.members) {
    for (const member of guild.members.values()) {
      const mUser = member.user || member
      const mId = member.id || mUser?.id
      if (!mId || member.bot || mUser?.bot) continue
      const live = profileFromMember(member)
      if (!live) continue
      const existing = profileMap.get(mId)
      profileMap.set(mId, existing ? mergeProfiles(existing, live) : live)
    }
  }

  for (const [authorID, authorProfile] of liveScan.authors) {
    if (!authorID || !authorProfile) continue
    const existing = profileMap.get(authorID)
    profileMap.set(authorID, existing ? mergeProfiles(existing, authorProfile) : authorProfile)
  }

  const msgsByUser = new Map(dbRecentMsgsByAuthor)
  for (const [authorID, liveMsgs] of liveScan.byAuthor) {
    const merged = mergeMessageLists(msgsByUser.get(authorID) || [], liveMsgs, 50)
    if (merged.length) msgsByUser.set(authorID, merged)
  }

  for (const authorID of msgsByUser.keys()) {
    if (!profileMap.has(authorID)) {
      profileMap.set(authorID, {
        userID: authorID,
        username: null,
        globalName: null,
        nick: null,
        avatarHash: null,
        avatarURL: null,
        accountCreatedAt: snowflakeToDate(authorID),
        joinedAt: null,
        inviteCode: null,
        status: 'active',
        statusAt: null,
        moderationReason: null
      })
    }
  }

  const allProfiles = [...profileMap.values()]
  const activeProfiles = allProfiles.filter(p => p.status === 'active')
  const formerProfiles = allProfiles.filter(p => p.status !== 'active')

  // Load historical messages (including mod-deleted & self-deleted snapshots) for up to 25 recent
  // banned/kicked/restricted/left profiles so disguised alts with 0 name/avatar match are caught.
  for (const former of formerProfiles.slice(0, 25)) {
    if (!msgsByUser.has(former.userID)) {
      const hist = await altDB.getMemberMessages(guild.id, former.userID, { limit: 40 }).catch(() => [])
      if (hist.length) msgsByUser.set(former.userID, hist)
    }
  }

  const seenPairs = new Set()
  const pairs = []

  const evalPair = (profileA, profileB) => {
    if (!profileA?.userID || !profileB?.userID || profileA.userID === profileB.userID) return
    const key = profileA.userID < profileB.userID
      ? `${profileA.userID}:${profileB.userID}`
      : `${profileB.userID}:${profileA.userID}`
    if (seenPairs.has(key)) return
    seenPairs.add(key)

    const msgsA = msgsByUser.get(profileA.userID) || []
    const msgsB = msgsByUser.get(profileB.userID) || []
    const heuristic = scorePair({
      suspectProfile: profileA,
      candidateProfile: profileB,
      suspectMessages: msgsA,
      candidateMessages: msgsB,
      now
    })
    if (heuristic.score >= minScore) {
      pairs.push({
        suspectProfile: profileA,
        candidateProfile: profileB,
        suspectMessages: msgsA,
        candidateMessages: msgsB,
        heuristic,
        ai: null
      })
    }
  }

  // 1. BAN/kick/offender/leave evasion: active members against former/restricted accounts
  if (scope === 'all' || scope === 'ban_evasion') {
    const activeSlice = activeProfiles.slice(0, 200)
    for (const active of activeSlice) {
      for (const former of formerProfiles) {
        evalPair(active, former)
      }
    }
  }

  // 2. Existing server members: active posters + active profiles (capped to keep latency < 50ms)
  if (scope === 'all' || scope === 'members') {
    const activeCandidates = activeProfiles
      .slice()
      .sort((a, b) => (msgsByUser.get(b.userID)?.length || 0) - (msgsByUser.get(a.userID)?.length || 0))
      .slice(0, 120)
    for (let i = 0; i < activeCandidates.length; i++) {
      for (let j = i + 1; j < activeCandidates.length; j++) {
        // Make the newer-joined account A ("suspect") and the older account B ("candidate")
        const p1 = activeCandidates[i]
        const p2 = activeCandidates[j]
        const t1 = p1.joinedAt ? new Date(p1.joinedAt).getTime() : 0
        const t2 = p2.joinedAt ? new Date(p2.joinedAt).getTime() : 0
        if (t2 > t1) evalPair(p2, p1)
        else evalPair(p1, p2)
      }
    }
  }

  pairs.sort((a, b) => {
    if (b.heuristic.score !== a.heuristic.score) return b.heuristic.score - a.heuristic.score
    const aMod = MOD_STATUSES.has(a.candidateProfile.status) ? 1 : 0
    const bMod = MOD_STATUSES.has(b.candidateProfile.status) ? 1 : 0
    return bMod - aMod
  })

  const topPairs = pairs.slice(0, Math.max(1, Math.min(10, limit)))

  // Calibrate top pairs with pgvector centroids + in-domain General Impostors, then run Stage 2 AI.
  const centroidCache = new Map()
  const getCentroid = async userID => {
    if (centroidCache.has(userID)) return centroidCache.get(userID)
    const vec = await altDB.getAuthorEmbeddingCentroid(guild.id, userID).catch(() => null)
    centroidCache.set(userID, vec)
    return vec
  }

  let verified = 0
  for (const item of topPairs) {
    if (verified >= aiVerifyTop) break
    if (item.heuristic.score < 30) break
    if (item.suspectMessages.length >= 3 && item.candidateMessages.length >= 3) {
      const [cA, cB] = await Promise.all([
        getCentroid(item.suspectProfile.userID),
        getCentroid(item.candidateProfile.userID)
      ])
      const impostors = pickImpostorMessages(msgsByUser, [item.suspectProfile.userID, item.candidateProfile.userID])
      if ((cA && cB) || impostors.length >= 3) {
        item.heuristic = scorePair({
          suspectProfile: item.suspectProfile,
          candidateProfile: item.candidateProfile,
          suspectMessages: item.suspectMessages,
          candidateMessages: item.candidateMessages,
          suspectCentroid: cA && cB ? cA : null,
          candidateCentroid: cA && cB ? cB : null,
          impostorMessages: impostors.length >= 3 ? impostors : null,
          now
        })
      }
    }
    item.ai = await analyzeWithGemini({
      guildID: guild.id,
      suspectProfile: item.suspectProfile,
      candidateProfile: item.candidateProfile,
      suspectMessages: item.suspectMessages,
      candidateMessages: item.candidateMessages,
      heuristic: item.heuristic,
      background: false
    })
    verified++
  }

  return {
    scope,
    channelsScanned: liveScan.channelsScanned,
    scannedProfiles: allProfiles.length,
    scannedActive: activeProfiles.length,
    scannedFormer: formerProfiles.length,
    scannedActivePosters: msgsByUser.size,
    pairs: topPairs.map(({ suspectProfile, candidateProfile, heuristic, ai }) => ({
      suspectProfile,
      candidateProfile,
      heuristic,
      ai
    }))
  }
}

module.exports = {
  MESSAGE_MILESTONES,
  SLEEPER_CHECK_MILESTONES,
  DEFAULT_OFFENDER_ROLE_IDS,
  isGlobalEnabled,
  offenderRoleIds,
  hasOffenderRole,
  joinAiThreshold,
  messageAiThreshold,
  maxDailyAutoAi,
  consumeAutoAiBudget,
  alertConfidence,
  alertCooldownHours,
  messageWatchDays,
  resetRuntimeState,
  snowflakeToDate,
  profileFromUser,
  profileFromMember,
  normalizeName,
  nameSimilarity,
  extractStylometry,
  cosineSimilarity,
  characterNgrams,
  distortJapaneseTopic,
  ruzickaSimilarity,
  topicAgnosticNgramFreq,
  extractJapaneseFunctionWords,
  compressionSimilarity,
  generalImpostorsScore,
  extractInterEventTimes,
  ksSimilarity,
  jensenShannonSimilarity,
  extractEmojis,
  extractMentionedUsers,
  extractUrlDomains,
  extractDistinctiveTokens,
  extractSentenceEndings,
  analyzeActivityHandover,
  jaccardSimilarity,
  hourHistogram,
  channelOverlap,
  countSimultaneousMessages,
  repostTextSimilarity,
  detectCrossAccountDeleteRepost,
  analyzeSelfDeleteBehavior,
  scorePair,
  resolveProfile,
  readableChannelsOf,
  mergeMessageLists,
  fetchAllGuildChannelMessages,
  findCandidates,
  parseAiJson,
  analyzeWithGemini,
  pickAlertEventName,
  resolveAlertDestination,
  verdictLabel,
  triggerLabel,
  statusLabelJa,
  statusLabelEn,
  formatUserLine,
  buildAlertEmbed,
  sendAltAlert,
  onMemberBan,
  onMemberLeave,
  onMemberUpdate,
  onMemberJoin,
  detectDeletionActorFromAuditLog,
  onMessageDelete,
  onMessageDeleteBulk,
  onMessageEdit,
  onMessage,
  investigateUser,
  compareUsers,
  scanServer
}
