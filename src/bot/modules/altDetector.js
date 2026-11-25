// Hybrid 2-stage AI alt-account (サブ垢) detection:
//   Stage 1 (deterministic, zero AI cost): account age, BAN/kick/leave timing proximity, invite
//     code match, custom avatar hash match, username/display-name similarity, Japanese/Discord
//     stylometry, character 3-grams, active-hours histogram, channel overlap, optional pgvector
//     embedding centroid, and simultaneous-message anti-false-positive penalty.
//   Stage 2 (Gemini precision verification): only invoked for suspicious candidates exceeding
//     Stage 1 thresholds (or manual /altcheck). Multimodal (optional avatar visual comparison)
//     with prompt-injection defense (<untrusted>) and structured JSON verdict.
// Alert-only to the server's staff log channel: never kicks, bans, or mutes automatically.
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
const MESSAGE_MILESTONES = [5, 15]
const MAX_COUNTER_ENTRIES = 10000
const SIMULTANEOUS_WINDOW_MS = 15 * 1000
const DEFAULT_OFFENDER_ROLE_IDS = ['882586674717138954']
const MOD_STATUSES = new Set(['banned', 'kicked', 'restricted'])
const ALERT_EVENT_PRIORITY = ['guildBanAdd', 'guildMemberKick', 'guildMemberAdd', 'guildMemberRemove', ...ALL_EVENTS]

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

function resetRuntimeState () {
  messageCounters.clear()
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
  const base = envNumber('ALT_JOIN_AI_THRESHOLD', 35, 0, 100)
  return isModCandidate ? base : Math.min(100, base + 15)
}

function messageAiThreshold () {
  return envNumber('ALT_MESSAGE_AI_THRESHOLD', 40, 0, 100)
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
  const n = texts.length
  const charDenom = Math.max(1, totalChars)
  return [
    Math.min(1, (totalChars / n) / 80),
    excl / n,
    quest / n,
    period / n,
    tilde / n,
    newline / n,
    kusa / n,
    laughW / n,
    laughKanji / n,
    emoji / n,
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
  return { score: jaccardSimilarity(setA, setB), sharedCount: [...setA].filter(c => setB.has(c)).length }
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
    hourSimilarity: null,
    channelOverlap: null,
    embeddingSimilarity: null,
    simultaneousMinutes: 0
  }

  const joinedAt = suspectProfile?.joinedAt ? new Date(suspectProfile.joinedAt) : null
  const createdAt = suspectProfile?.accountCreatedAt ? new Date(suspectProfile.accountCreatedAt) : null
  const candStatusAt = candidateProfile?.statusAt ? new Date(candidateProfile.statusAt) : null
  const candIsMod = MOD_STATUSES.has(candidateProfile?.status)

  // 1. BAN / kick / leave timing proximity
  if (joinedAt && candStatusAt) {
    const delta = joinedAt.getTime() - candStatusAt.getTime()
    metrics.timingDeltaMs = delta
    if (delta >= -60 * 1000) {
      const clampedDelta = Math.max(0, delta)
      if (candIsMod) {
        const actionLabel = candidateProfile.status === 'banned'
          ? 'BAN'
          : (candidateProfile.status === 'kicked' ? 'キック' : '違反者ロール付与')
        if (clampedDelta <= 2 * 3600 * 1000) {
          raw += 35
          signals.push(`候補の${actionLabel}から${formatDurationJa(clampedDelta)}後に参加（極めて近接）`)
        } else if (clampedDelta <= 24 * 3600 * 1000) {
          raw += 25
          signals.push(`候補の${actionLabel}から${formatDurationJa(clampedDelta)}後に参加`)
        } else if (clampedDelta <= 7 * 86400 * 1000) {
          raw += 15
          signals.push(`候補の${actionLabel}から${formatDurationJa(clampedDelta)}後に参加`)
        } else if (clampedDelta <= 30 * 86400 * 1000) {
          raw += 8
          signals.push(`候補の${actionLabel}から${formatDurationJa(clampedDelta)}後に参加`)
        }
      } else if (candidateProfile?.status === 'left' && clampedDelta <= 24 * 3600 * 1000) {
        raw += 12
        signals.push(`候補の退出から${formatDurationJa(clampedDelta)}以内に参加`)
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

    if (candIsMod && candStatusAt) {
      const createdAfter = createdAt.getTime() - candStatusAt.getTime()
      if (createdAfter >= -60 * 1000 && createdAfter <= 14 * 86400 * 1000) {
        metrics.createdAfterMod = true
        raw += 10
        signals.push('候補のBAN/キック/違反者ロール付与後に新規作成されたアカウント')
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

  // 6. Behavioral & linguistic signals (requires >= 3 messages from both accounts)
  if (suspectMessages.length >= 3 && candidateMessages.length >= 3) {
    const styloA = extractStylometry(suspectMessages)
    const styloB = extractStylometry(candidateMessages)
    if (styloA && styloB) {
      const styloSim = cosineSimilarity(styloA, styloB)
      metrics.stylometrySimilarity = Number(styloSim.toFixed(3))
      if (styloSim >= 0.94) {
        raw += 20
        signals.push(`文体特徴が高度に一致（類似度 ${Math.round(styloSim * 100)}%）`)
      } else if (styloSim >= 0.88) {
        raw += 12
        signals.push(`文体特徴が類似（類似度 ${Math.round(styloSim * 100)}%）`)
      } else if (styloSim >= 0.82) {
        raw += 6
        signals.push(`文体特徴にやや類似傾向（類似度 ${Math.round(styloSim * 100)}%）`)
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

    if (suspectMessages.length >= 5 && candidateMessages.length >= 5) {
      const hourSim = cosineSimilarity(hourHistogram(suspectMessages), hourHistogram(candidateMessages))
      metrics.hourSimilarity = Number(hourSim.toFixed(3))
      if (hourSim >= 0.80) {
        raw += 10
        signals.push(`活動時間帯（JST）が強く一致（類似度 ${Math.round(hourSim * 100)}%）`)
      } else if (hourSim >= 0.65) {
        raw += 5
        signals.push(`活動時間帯（JST）が類似（類似度 ${Math.round(hourSim * 100)}%）`)
      }
    }

    const chan = channelOverlap(suspectMessages, candidateMessages)
    metrics.channelOverlap = Number(chan.score.toFixed(3))
    if (chan.score >= 0.5 && chan.sharedCount >= 2) {
      raw += 8
      signals.push(`よく発言するチャンネルが重複（${chan.sharedCount}チャンネル）`)
    }

    if (suspectCentroid && candidateCentroid) {
      const embSim = cosineSimilarity(suspectCentroid, candidateCentroid)
      metrics.embeddingSimilarity = Number(embSim.toFixed(3))
      if (embSim >= 0.82) {
        raw += 18
        signals.push(`発言トピックの意味ベクトルが強く類似（${Math.round(embSim * 100)}%）`)
      } else if (embSim >= 0.72) {
        raw += 10
        signals.push(`発言トピックの意味ベクトルが類似（${Math.round(embSim * 100)}%）`)
      }
    }

    // Anti-false-positive: simultaneous messages
    const simultaneous = countSimultaneousMessages(suspectMessages, candidateMessages)
    metrics.simultaneousMinutes = simultaneous
    if (simultaneous >= 3) {
      raw -= 25
      counterSignals.push(`同時刻（15秒以内）に ${simultaneous} 回以上やり取りしており、別人の可能性が高い`)
    } else if (simultaneous >= 1) {
      raw -= 5
      counterSignals.push(`同時刻（15秒以内）に ${simultaneous} 回の発言あり`)
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  return { score, signals, counterSignals, metrics }
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

async function findCandidates (guild, suspectProfile, suspectMessages = [], { trigger = 'manual', now = new Date(), limit = 5, includeGuildMembers = true } = {}) {
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

  let recentMsgsByAuthor = new Map()
  if (suspectMessages.length >= 3) {
    recentMsgsByAuthor = await altDB.getRecentAuthorsMessages(guild.id, suspectProfile.userID, {
      authorLimit: 30,
      perAuthor: 30,
      days: 30
    }).catch(() => new Map())
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
  }

  // First pass: score every candidate using available profiles and active-author messages.
  const scored = []
  for (const [candidateID, candidateProfile] of candidateMap) {
    const msgs = recentMsgsByAuthor.get(candidateID) || []
    const heuristic = scorePair({
      suspectProfile,
      candidateProfile,
      suspectMessages,
      candidateMessages: msgs,
      now
    })
    scored.push({ candidateProfile, candidateMessages: msgs, heuristic })
  }

  // When the suspect has messages, also check historical messages of top banned/kicked/left
  // accounts whose messages may be older than 30 days (not included in recentMsgsByAuthor).
  if (suspectMessages.length >= 3) {
    const modToEnrich = scored
      .filter(item => item.candidateProfile.status !== 'active' && item.candidateMessages.length === 0)
      .sort((a, b) => b.heuristic.score - a.heuristic.score)
      .slice(0, 5)
    for (const item of modToEnrich) {
      const msgs = await altDB.getMemberMessages(guild.id, item.candidateProfile.userID, { limit: 40 }).catch(() => [])
      if (msgs.length >= 3) {
        item.candidateMessages = msgs
        item.heuristic = scorePair({
          suspectProfile,
          candidateProfile: item.candidateProfile,
          suspectMessages,
          candidateMessages: msgs,
          now
        })
      }
    }
  }

  scored.sort((a, b) => {
    if (b.heuristic.score !== a.heuristic.score) return b.heuristic.score - a.heuristic.score
    const aMod = MOD_STATUSES.has(a.candidateProfile.status) ? 1 : 0
    const bMod = MOD_STATUSES.has(b.candidateProfile.status) ? 1 : 0
    return bMod - aMod
  })

  // Optional pgvector semantic centroid boost for top 3 candidates with >= 3 messages.
  const top = scored.slice(0, Math.max(limit, 3))
  if (suspectMessages.length >= 3 && top.some(item => item.candidateMessages.length >= 3)) {
    const suspectCentroid = await altDB.getAuthorEmbeddingCentroid(guild.id, suspectProfile.userID).catch(() => null)
    if (suspectCentroid) {
      for (const item of top.slice(0, 3)) {
        if (item.candidateMessages.length < 3) continue
        const candCentroid = await altDB.getAuthorEmbeddingCentroid(guild.id, item.candidateProfile.userID).catch(() => null)
        if (candCentroid) {
          item.heuristic = scorePair({
            suspectProfile,
            candidateProfile: item.candidateProfile,
            suspectMessages,
            candidateMessages: item.candidateMessages,
            suspectCentroid,
            candidateCentroid: candCentroid,
            now
          })
        }
      }
      top.sort((a, b) => b.heuristic.score - a.heuristic.score)
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
    const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return `[${ts}] (ch:${m.channelID || '?'}) ${text}`
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

async function fetchAvatarPair (suspectProfile, candidateProfile) {
  if (!suspectProfile?.avatarHash || !candidateProfile?.avatarHash) return null
  if (!suspectProfile.avatarURL || !candidateProfile.avatarURL) return null
  if (suspectProfile.avatarHash === candidateProfile.avatarHash) return null
  try {
    const [imgA, imgB] = await Promise.all([
      urlFetcher.fetchImage(suspectProfile.avatarURL),
      urlFetcher.fetchImage(candidateProfile.avatarURL)
    ])
    const mime = ct => (String(ct || '').split(';')[0].trim() || 'image/png')
    return [
      { inlineData: { mimeType: mime(imgA.contentType), data: imgA.buffer.toString('base64') } },
      { inlineData: { mimeType: mime(imgB.contentType), data: imgB.buffer.toString('base64') } }
    ]
  } catch (_) {
    return null
  }
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
  const avatars = fetchAvatars ? await fetchAvatarPair(suspectProfile, candidateProfile) : null
  const promptText = prompts.render('alt/analyze', {
    heuristicSummary: formatHeuristicBlock(heuristic),
    suspectProfile: untrusted.wrap('suspect_profile', formatProfileBlock(suspectProfile)),
    candidateProfile: untrusted.wrap('candidate_profile', formatProfileBlock(candidateProfile)),
    suspectMessages: formatMessagesBlock(suspectMessages, 'suspect_messages'),
    candidateMessages: formatMessagesBlock(candidateMessages, 'candidate_messages'),
    avatarsAttached: Boolean(avatars)
  })
  const parts = [{ text: promptText }]
  if (avatars) {
    parts.push({ text: '調査対象 A のアバター画像:' }, avatars[0], { text: '候補 B のアバター画像:' }, avatars[1])
  }
  const { model, thinking, flex } = await resolveTaskConfig('light', guildID)
  const invoke = () => callGemini(model, {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: ALT_RESPONSE_SCHEMA,
      ...(avatars ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
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

  let guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  if (!guildSettings && global.bot) {
    await cacheGuild(guild.id).catch(() => {})
    guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  }
  const eventName = pickAlertEventName(guildSettings)
  if (!eventName) return { sent: false, reason: 'no_log_channel' }

  const embed = buildAlertEmbed({ suspectProfile, candidateProfile, heuristic, ai, trigger, lang: 'ja' })
  await send({ guildID: guild.id, eventName, embeds: [embed] })
  return { sent: true, eventName, embed }
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

  for (const cand of candidates.slice(0, 2)) {
    const threshold = joinAiThreshold(MOD_STATUSES.has(cand.candidateProfile.status))
    if (cand.heuristic.score < threshold) continue
    if (await altDB.hasRecentAlert(guild.id, profile.userID, cand.candidateProfile.userID, alertCooldownHours())) continue

    const ai = await analyzeWithGemini({
      guildID: guild.id,
      suspectProfile: profile,
      candidateProfile: cand.candidateProfile,
      suspectMessages: [],
      candidateMessages: cand.candidateMessages,
      heuristic: cand.heuristic,
      background: true
    })
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

async function onMessage (message, { now = new Date() } = {}) {
  const guild = message?.channel?.guild
  const guildID = guild?.id || message?.guildID
  if (!guildID || !message?.author?.id || message.author.bot) return { checked: false }
  if (!String(message.content || '').trim()) return { checked: false }
  if (!isGlobalEnabled()) return { checked: false }

  const member = message.member
  if (member?.joinedAt) {
    const joinedAgeMs = now.getTime() - new Date(member.joinedAt).getTime()
    if (joinedAgeMs > messageWatchDays() * 86400 * 1000) return { checked: false }
  }

  if (!(await altDB.isAltDetectionEnabled(guildID))) return { checked: false }

  const entry = bumpMessageCounter(guildID, message.author.id)
  if (!MESSAGE_MILESTONES.includes(entry.count) || entry.checked.has(entry.count)) {
    return { checked: false }
  }
  entry.checked.add(entry.count)

  const resolvedGuild = guild || global.bot?.guilds?.get?.(guildID)
  if (!resolvedGuild) return { checked: false }

  const suspectProfile = await resolveProfile(resolvedGuild, message.author.id)
  if (suspectProfile.joinedAt) {
    const joinedAgeMs = now.getTime() - new Date(suspectProfile.joinedAt).getTime()
    if (joinedAgeMs > messageWatchDays() * 86400 * 1000) return { checked: false }
  }

  const storedMsgs = await altDB.getMemberMessages(guildID, message.author.id, { limit: 40 }).catch(() => [])
  const hasCurrent = storedMsgs.some(m => m.id === message.id)
  const suspectMessages = hasCurrent
    ? storedMsgs
    : [{
        id: message.id || `live-${now.getTime()}`,
        authorID: message.author.id,
        channelID: message.channel?.id || null,
        content: message.content,
        ts: message.timestamp ? new Date(message.timestamp) : now
      }, ...storedMsgs]

  if (suspectMessages.length < 3) return { checked: true, alerted: false }

  const candidates = await findCandidates(resolvedGuild, suspectProfile, suspectMessages, { trigger: 'messages', now, limit: 3 })
  if (!candidates.length) return { checked: true, alerted: false }

  const threshold = messageAiThreshold()
  for (const cand of candidates.slice(0, 2)) {
    if (cand.heuristic.score < threshold) continue
    if (await altDB.hasRecentAlert(guildID, suspectProfile.userID, cand.candidateProfile.userID, alertCooldownHours())) continue

    const ai = await analyzeWithGemini({
      guildID,
      suspectProfile,
      candidateProfile: cand.candidateProfile,
      suspectMessages,
      candidateMessages: cand.candidateMessages,
      heuristic: cand.heuristic,
      background: true
    })
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

async function investigateUser (guild, userID, { now = new Date() } = {}) {
  const suspectProfile = await resolveProfile(guild, userID)
  const suspectMessages = await altDB.getMemberMessages(guild.id, userID, { limit: 50 }).catch(() => [])
  const candidates = await findCandidates(guild, suspectProfile, suspectMessages, { trigger: 'manual', now, limit: 5 })
  const topCandidate = candidates[0] || null
  let ai = null
  if (topCandidate && topCandidate.heuristic.score >= 15) {
    ai = await analyzeWithGemini({
      guildID: guild.id,
      suspectProfile,
      candidateProfile: topCandidate.candidateProfile,
      suspectMessages,
      candidateMessages: topCandidate.candidateMessages,
      heuristic: topCandidate.heuristic,
      background: false
    })
  }
  return {
    suspectProfile,
    suspectMessageCount: suspectMessages.length,
    candidates,
    topCandidate,
    ai
  }
}

async function compareUsers (guild, userID1, userID2, { now = new Date() } = {}) {
  const [suspectProfile, candidateProfile, suspectMessages, candidateMessages] = await Promise.all([
    resolveProfile(guild, userID1),
    resolveProfile(guild, userID2),
    altDB.getMemberMessages(guild.id, userID1, { limit: 50 }).catch(() => []),
    altDB.getMemberMessages(guild.id, userID2, { limit: 50 }).catch(() => [])
  ])
  let suspectCentroid = null
  let candidateCentroid = null
  if (suspectMessages.length >= 3 && candidateMessages.length >= 3) {
    ;[suspectCentroid, candidateCentroid] = await Promise.all([
      altDB.getAuthorEmbeddingCentroid(guild.id, userID1).catch(() => null),
      altDB.getAuthorEmbeddingCentroid(guild.id, userID2).catch(() => null)
    ])
  }
  const heuristic = scorePair({
    suspectProfile,
    candidateProfile,
    suspectMessages,
    candidateMessages,
    suspectCentroid,
    candidateCentroid,
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
    heuristic,
    ai
  }
}

// Scans the server for suspicious alt-account pairs (BAN/kick evasion and/or same-person
// existing members). Stage 1 runs in memory at zero AI cost; Stage 2 Gemini analysis runs
// on the top suspicious pair(s) so moderators get precision verdicts without runaway token cost.
async function scanServer (guild, { scope = 'all', limit = 5, aiVerifyTop = 2, minScore = 25, now = new Date() } = {}) {
  const stored = await altDB.getCandidateProfiles(guild.id, '', { limit: 200 }).catch(() => [])
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

  const recentMsgsByAuthor = await altDB.getRecentAuthorsMessages(guild.id, '', {
    authorLimit: 40,
    perAuthor: 30,
    days: 30
  }).catch(() => new Map())

  for (const authorID of recentMsgsByAuthor.keys()) {
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

  // Load historical messages for the most recent banned/kicked/left profiles so writing-style
  // matching works even if their ban occurred more than 30 days ago.
  const msgsByUser = new Map(recentMsgsByAuthor)
  for (const former of formerProfiles.slice(0, 10)) {
    if (!msgsByUser.has(former.userID)) {
      const hist = await altDB.getMemberMessages(guild.id, former.userID, { limit: 30 }).catch(() => [])
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

  // 1. BAN/kick/leave evasion: active members against former (banned/kicked/left) accounts
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

  // Stage 2 Gemini precision verification for top suspicious pairs
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
      if (cA && cB) {
        item.heuristic = scorePair({
          suspectProfile: item.suspectProfile,
          candidateProfile: item.candidateProfile,
          suspectMessages: item.suspectMessages,
          candidateMessages: item.candidateMessages,
          suspectCentroid: cA,
          candidateCentroid: cB,
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
    scannedProfiles: allProfiles.length,
    scannedActive: activeProfiles.length,
    scannedFormer: formerProfiles.length,
    scannedActivePosters: recentMsgsByAuthor.size,
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
  DEFAULT_OFFENDER_ROLE_IDS,
  isGlobalEnabled,
  offenderRoleIds,
  hasOffenderRole,
  joinAiThreshold,
  messageAiThreshold,
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
  jaccardSimilarity,
  hourHistogram,
  channelOverlap,
  countSimultaneousMessages,
  scorePair,
  resolveProfile,
  findCandidates,
  parseAiJson,
  analyzeWithGemini,
  pickAlertEventName,
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
  onMessage,
  investigateUser,
  compareUsers,
  scanServer
}
