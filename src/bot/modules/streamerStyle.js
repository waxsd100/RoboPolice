// How the streamer speaks, learned from the streamer's own first-party corpus (Discord messages
// and 2-turn reply exchanges in the owner's public channels, X posts and replies, Steam reviews,
// YouTube spoken captions/quoted speech, and extracted quotes) so chat replies in streamerPersona
// mode sound like the person rather than a generic YouTuber.
//
// Follows a four-part architecture from role-playing and style-transfer research:
//   1. Stylometric & Text Style Definition (CAT-LLM / Fic2Bot): deterministic punctuation, length
//      and laugh-marker statistics computed strictly from written text-chat utterances (never
//      skewed by unpunctuated ASR captions), paired with a compact LLM-extracted linguistic &
//      situational reaction profile (CAPS).
//   2. Offline DPRF 1-round iterative refinement (Dynamic Persona Refinement Framework): during
//      background refresh only (zero extra calls per user mention), holds out real 2-turn dialogue
//      pairs, simulates replies from the initial profile in one batched call, compares simulated
//      vs. real replies, and refines the profile to remove AI-like drift.
//   3. Dialogue-pair & utterance-level few-shot exemplars (ChatHaruhi / RoleLLM / PICLe): 2-turn
//      real exchanges (`相手 → 本人`) selected with speech-act matching + MMR diversity alongside
//      short everyday utterances, decoupled from past topics so voice/cadence transfer without
//      dragging in old subjects.
//   4. Catchphrase gating & multi-tier persistence (RoleLLM / DITTO): famous wiki quotes are kept
//      separate from everyday speech, and the profile is persisted in L1 memory, L2 Redis, and L3
//      Postgres so restarts, Redis outages, and non-shard-0 workers share it immediately.
const crypto = require('crypto')
const prompts = require('../utils/prompts')
const aiCache = require('../utils/aiCache')
const youtubeCaptions = require('../utils/youtubeCaptions')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')
const { looksLikeInjection } = require('../utils/untrusted')
const { isUnsafeMinorContent } = require('../utils/minorSafety')
const { relevant } = require('../utils/relevance')
const { model: embeddingModel } = require('../utils/embeddings')
const { ownerGuildIDs } = require('../utils/priority')
const { knowledgeSetting } = require('../utils/knowledgeDefaults')
const discordPosts = require('../../db/interfaces/postgres/discordPosts')
const xPosts = require('../../db/interfaces/postgres/xPosts')
const steamDB = require('../../db/interfaces/postgres/steam')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const wikiStore = require('../../db/interfaces/postgres/wiki')
const xKnowledgeStore = require('../../db/interfaces/postgres/xKnowledge')
const discordKnowledgeStore = require('../../db/interfaces/postgres/discordKnowledge')
const styleStore = require('../../db/interfaces/postgres/streamerStyle')

const REDIS_KEY = 'streamer-style:v3'
const STYLE_KEY = styleStore.DEFAULT_KEY || 'default'
const REDIS_TTL_SECONDS = 7 * 24 * 60 * 60
const MEMORY_TTL_MS = 5 * 60 * 1000
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const STARTUP_REFRESH_DELAY_MS = 5 * 1000
const MIN_UTTERANCES_FOR_PROFILE = 8
const MIN_DPRF_PAIRS = 4
const MAX_DPRF_EVAL_PAIRS = 6
const MAX_CORPUS_CHARS = 16000
const MAX_PAIR_CORPUS_CHARS = 3500
const MAX_SPOKEN_CORPUS_CHARS = 4500
const MAX_PROFILE_CHARS = 950
const MAX_EXEMPLAR_POOL = 40
const MAX_PAIR_POOL = 24
const MAX_QUOTES = 10
const MAX_CAPTION_VIDEOS = 4
const CAPTION_FETCH_DELAY_MS = 400

// Announcements, automated share text, and PR notices do not reflect natural chat cadence.
const ANNOUNCEMENT_NOISE_RE = /(?:動画を投稿しました|動画を公開しました|プレミア公開|配信開始|生放送開始|ライブ配信中|YouTubeに動画を|#PR\b|#提供\b|#案件\b)/i
const COLLAB_VIDEO_TITLE_RE = /コラボ|トマスコ|ぽみそしる|マルチ(?:プレイ)?|全員集合|人狼|Among\s*Us|マリオパーティ|対決|\bvs\b|feat\.|with\s/iu
const NON_SELF_QUOTE_RE = /(?:視聴者|コメント|リスナー|NPC|敵キャラ|村人|住民|(?:きりやん|ぐちつぼ|やみえん|ポッキー|赤髪のとも|カンタ|ちはや|ふうはや|ネフライト|おらふくん|あきピヨ)の(?:発言|台詞|名言))/iu
const REAL_SOURCE_HASH_RE = /^[0-9a-f]{8}:[0-9a-f]{24}$/
const SECTION_LINE_RE = /^\[[\d-]+\](?:\s+(?:#\S+:|@\w+\s*への返信:))?\s*(.+)$/
const GREETING_ACT_RE = /^(?:おは|こん(?:にち|ばん|ちゃ)|おつ|ただいま|おやすみ|やあ|よっ|ハロー|あけおめ|初めまして|はじめまして)/iu
const QUESTION_ACT_RE = /[?？]|(?:おすすめ|教えて|どう(?:思|かな|だろ|だった)|何(?:が|を|か)|どれが|どっち|いつ|どこ)/u
const W_LAUGH_RE = /(?:[ぁ-んァ-ヶ一-龠a-z0-9]|^)[wｗ]{1,6}(?:$|[\s!！?？。、])/iu
const KUSA_LAUGH_RE = /草/u
const KAKKO_LAUGH_RE = /[（(]?笑[)）]?$/u
const POLITE_END_RE = /(?:です|ます|でした|ました|ません|でしょう)(?:[ねよかよねな]*)[。！!？?…ー〜wｗ草笑）)]*$/u
const DAZE_END_RE = /(?:だぜ|いくぜ|やるぜ|しようぜ|るぜ|いぜ|ないぜ|たぜ)(?:[。！!？?…ー〜wｗ草笑）)]|$)/u
const DAZO_END_RE = /(?:だぞ|いくぞ|やるぞ|るぞ|いぞ|ないぞ|たぞ)(?:[。！!？?…ー〜wｗ草笑）)]|$)/u

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let memoryEntry = null
let memoryLoadedAt = 0
let refreshing = null

function steamAccounts () {
  return String(knowledgeSetting('STEAM_ACCOUNTS')).split(',').map(s => s.trim()).filter(Boolean)
}

function youtubeChannels () {
  return String(knowledgeSetting('YOUTUBE_CHANNELS')).split(',').map(s => s.trim()).filter(Boolean)
}

function enabled () {
  const twitter = require('./twitterKnowledge')
  const discord = require('./discordKnowledge')
  const wiki = require('./wikiKnowledge')
  return twitter.enabled() || discord.enabled() || steamAccounts().length !== 0 || wiki.enabled() || youtubeChannels().length !== 0
}

// Strips URLs, leading @reply handles, and Discord mention codes to leave the speaker's own words.
function cleanUtterance (raw) {
  let s = String(raw || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^(?:@\w+\s+)+/g, '')
    .replace(/<@[!&]?\d+>|<#\d+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  s = s.replace(/^(?:@\w+\s*への返信:\s*)/, '').trim()
  if (!s) return ''
  const plain = s.replace(/<a?:\w+:\d+>|[\s\p{P}\p{S}]/gu, '')
  if ([...plain].length < 4) return ''
  if (ANNOUNCEMENT_NOISE_RE.test(s)) return ''
  if (looksLikeInjection(s) || isUnsafeMinorContent(s)) return ''
  return s.slice(0, 220)
}

// Cleans the partner's prompt in a 2-turn conversation pair.
function cleanPartnerPrompt (raw) {
  const s = String(raw || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^(?:@\w+\s+)+/g, '')
    .replace(/<@[!&]?\d+>|<#\d+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, ' ')
    .trim()
  if (!s) return ''
  const plain = s.replace(/<a?:\w+:\d+>|[\s\p{P}\p{S}]/gu, '')
  if ([...plain].length < 4) return ''
  if (ANNOUNCEMENT_NOISE_RE.test(s)) return ''
  if (looksLikeInjection(s) || isUnsafeMinorContent(s)) return ''
  return s.slice(0, 140)
}

// Scores how useful a short utterance is as a conversational speaking-style exemplar (PICLe):
// favours natural 12-120 character Discord/reply utterances over fragments or wall-of-text notices,
// without biasing toward exclamation marks, laugh markers (w/草), or exaggerated sentence-final particles.
function utteranceSalience (text, { isReply = false, source = 'x' } = {}) {
  const chars = [...String(text || '')].length
  if (chars < 8 || chars > 160) return -1
  let score = 1
  if (chars >= 14 && chars <= 95) score += 0.5
  if (source === 'discord') score += 0.5
  else if (source === 'x') score += 0.15
  if (isReply) score += 0.3
  if (/\n/.test(text) && text.split('\n').length <= 3) score += 0.05
  return score
}

// Scores a 2-turn dialogue pair (`partner -> reply`), favouring explicit Discord replies and
// natural conversational exchanges without biasing toward slang or laugh markers.
function pairSalience ({ partner, reply, explicit = false } = {}) {
  const replyScore = utteranceSalience(reply, { source: 'discord', isReply: true })
  if (replyScore <= 0) return -1
  const pChars = [...String(partner || '')].length
  if (pChars < 4 || pChars > 120) return -1
  let score = replyScore
  if (explicit) score += 0.5
  if (pChars >= 8 && pChars <= 75) score += 0.2
  if (QUESTION_ACT_RE.test(partner) || GREETING_ACT_RE.test(partner)) score += 0.15
  return score
}

// Character bigrams for fast lexical overlap penalty (MMR exemplar diversification).
function bigramsOf (text) {
  const clean = String(text || '').replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

function jaccard (a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function markerPenalty (text, { rates = null, used = null } = {}) {
  if (!rates && !used) return 0
  let penalty = 0
  const hasKusa = KUSA_LAUGH_RE.test(text)
  const hasW = W_LAUGH_RE.test(text)
  const hasDaze = DAZE_END_RE.test(text) || DAZO_END_RE.test(text)
  if (hasKusa) {
    if (used && used.kusa >= 1) penalty += 0.9
    else if (rates && rates.kusaRate < 0.15) penalty += 0.45
  }
  if (hasW) {
    if (used && used.w >= 1) penalty += 0.85
    else if (rates && rates.wRate < 0.10) penalty += 0.4
  }
  if (hasDaze) {
    if (used && used.daze >= 1) penalty += 0.9
    else if (rates && rates.dazeRate < 0.10) penalty += 0.6
  }
  return penalty
}

function recordMarkers (text, used) {
  if (!used) return
  if (KUSA_LAUGH_RE.test(text)) used.kusa++
  if (W_LAUGH_RE.test(text)) used.w++
  if (DAZE_END_RE.test(text) || DAZO_END_RE.test(text)) used.daze++
}

// Picks `count` diverse utterances using Maximal Marginal Relevance over salience vs. lexical overlap.
function diversifyUtterances (candidates, count, { lambda = 0.72, rates = null, used = null } = {}) {
  const items = candidates.map(c => ({
    text: typeof c === 'string' ? c : c.text,
    score: typeof c === 'string' ? 1 : (c.score ?? 1),
    grams: bigramsOf(typeof c === 'string' ? c : c.text)
  }))
  const picked = []
  const seen = new Set()
  while (picked.length < count && items.length) {
    let best = null
    let bestVal = -Infinity
    for (const item of items) {
      if (seen.has(item.text)) continue
      const overlap = picked.length ? Math.max(...picked.map(p => jaccard(item.grams, p.grams))) : 0
      if (overlap >= 0.65) continue
      const adjScore = item.score - markerPenalty(item.text, { rates, used })
      const val = lambda * adjScore - (1 - lambda) * overlap
      if (val > bestVal) {
        best = item
        bestVal = val
      }
    }
    if (!best) break
    seen.add(best.text)
    picked.push(best)
    recordMarkers(best.text, used)
  }
  return picked.map(p => p.text)
}

// Picks `count` diverse 2-turn dialogue pairs using MMR over reply and prompt bigrams.
function diversifyPairs (candidates, count, { lambda = 0.72, rates = null, used = null } = {}) {
  const items = (candidates || [])
    .filter(c => c?.partner && c?.reply)
    .map(c => ({
      partner: c.partner,
      reply: c.reply,
      score: c.score ?? 1,
      replyGrams: bigramsOf(c.reply),
      partnerGrams: bigramsOf(c.partner)
    }))
  const picked = []
  const seenReply = new Set()
  const seenPartner = new Set()
  while (picked.length < count && items.length) {
    let best = null
    let bestVal = -Infinity
    for (const item of items) {
      if (seenReply.has(item.reply) || seenPartner.has(item.partner)) continue
      const replyOverlap = picked.length ? Math.max(...picked.map(p => jaccard(item.replyGrams, p.replyGrams))) : 0
      const partnerOverlap = picked.length ? Math.max(...picked.map(p => jaccard(item.partnerGrams, p.partnerGrams))) : 0
      if (replyOverlap >= 0.65 || partnerOverlap >= 0.75) continue
      const overlap = Math.max(replyOverlap, partnerOverlap * 0.7)
      const adjScore = item.score - markerPenalty(item.reply, { rates, used })
      const val = lambda * adjScore - (1 - lambda) * overlap
      if (val > bestVal) {
        best = item
        bestVal = val
      }
    }
    if (!best) break
    seenReply.add(best.reply)
    seenPartner.add(best.partner)
    picked.push(best)
    recordMarkers(best.reply, used)
  }
  return picked.map(({ partner, reply }) => ({ partner, reply }))
}

// Classifies conversational speech act (not topic) so 2-turn exemplars match the kind of
// exchange (greeting, question, short reaction, casual chat) without dragging in past topics.
function classifySpeechAct (text) {
  const s = String(text || '').trim()
  if (!s) return 'casual'
  if (GREETING_ACT_RE.test(s)) return 'greeting'
  if (QUESTION_ACT_RE.test(s)) return 'question'
  if ([...s].length <= 30 && /[wｗ草!！笑]/u.test(s)) return 'reaction'
  return 'casual'
}

function pickDialoguePairs (pool, count, { query = '', rates = null, used = null } = {}) {
  if (!Array.isArray(pool) || !pool.length || count <= 0) return []
  const act = classifySpeechAct(query)
  const scored = pool.map((p, idx) => ({
    partner: p.partner,
    reply: p.reply,
    score: Math.max(0.5, 1.2 - idx * 0.025) + (act !== 'casual' && classifySpeechAct(p.partner) === act ? 0.35 : 0)
  }))
  return diversifyPairs(scored, count, { rates, used })
}

// Objective micro-level stylometric indicators (CAT-LLM / Fic2Bot) computed directly from the
// streamer's written text-chat utterances so the LLM style summary stays anchored in real
// frequencies (never skewed by unpunctuated YouTube auto-captions or roleplay stereotypes).
function computeStylometrics (utterances) {
  if (!utterances.length) return ''
  const n = utterances.length
  const lengths = utterances.map(u => [...u].length).sort((a, b) => a - b)
  const medianLen = lengths[Math.floor(lengths.length / 2)]
  const pct = count => `${Math.round((count / n) * 100)}%`
  const withPeriod = utterances.filter(u => /。/.test(u)).length
  const withComma = utterances.filter(u => /、/.test(u)).length
  const withExclam = utterances.filter(u => /[!！]/.test(u)).length
  const withQuestion = utterances.filter(u => /[?？]/.test(u)).length
  const multiLine = utterances.filter(u => /\n/.test(u)).length
  const withPolite = utterances.filter(u => POLITE_END_RE.test(u)).length
  const withDaze = utterances.filter(u => DAZE_END_RE.test(u)).length
  const withDazo = utterances.filter(u => DAZO_END_RE.test(u)).length
  const wLaugh = utterances.filter(u => W_LAUGH_RE.test(u)).length
  const kusaLaugh = utterances.filter(u => KUSA_LAUGH_RE.test(u)).length
  const kakkoLaugh = utterances.filter(u => KAKKO_LAUGH_RE.test(u)).length
  const anyLaugh = utterances.filter(u => W_LAUGH_RE.test(u) || KUSA_LAUGH_RE.test(u) || KAKKO_LAUGH_RE.test(u)).length
  return [
    `- 分析対象の発言数: ${n}件、1発言の長さ中央値: 約${medianLen}文字、改行を含む発言: ${pct(multiLine)}`,
    `- 文末の割合: です・ます調 ${pct(withPolite)}、普通体・体言止め ${pct(n - withPolite)}（うち語尾「〜だぜ／〜ぜ」${pct(withDaze)}、「〜だぞ／〜ぞ」${pct(withDazo)}）`,
    `- 句読点・記号を含む割合: 句点「。」${pct(withPeriod)}、読点「、」${pct(withComma)}、感嘆符「!／！」${pct(withExclam)}、疑問符「?／？」${pct(withQuestion)}`,
    `- 笑い表現を含む割合: 笑い表現なし ${pct(n - anyLaugh)}、「w」${pct(wLaugh)}、「草」${pct(kusaLaugh)}、「笑」${pct(kakkoLaugh)}`
  ].join('\n')
}

function inferMarkerRates (entry) {
  const q = String(entry?.quantitative || '')
  const readPct = pattern => {
    const m = q.match(pattern)
    return m ? Number(m[1]) / 100 : null
  }
  const qKusa = readPct(/「草」(\d+)%/)
  const qW = readPct(/「w」(\d+)%/)
  const qDaze = readPct(/「〜だぜ／〜ぜ」(\d+)%/)
  const qDazo = readPct(/「〜だぞ／〜ぞ」(\d+)%/)
  if (qKusa !== null && qW !== null) {
    return {
      kusaRate: qKusa,
      wRate: qW,
      dazeRate: (qDaze || 0) + (qDazo || 0)
    }
  }
  const samples = [
    ...(entry?.dialoguePairs || []).map(p => p?.reply).filter(Boolean),
    ...(entry?.exemplars || []).filter(Boolean)
  ]
  if (!samples.length) return { kusaRate: 0, wRate: 0, dazeRate: 0 }
  const n = samples.length
  return {
    kusaRate: samples.filter(s => KUSA_LAUGH_RE.test(s)).length / n,
    wRate: samples.filter(s => W_LAUGH_RE.test(s)).length / n,
    dazeRate: samples.filter(s => DAZE_END_RE.test(s) || DAZO_END_RE.test(s)).length / n
  }
}

function fitLines (lines, maxChars) {
  const total = lines.reduce((sum, l) => sum + l.length + 1, 0)
  if (total <= maxChars) return lines
  const keep = Math.max(1, Math.floor(lines.length * maxChars / total))
  return Array.from({ length: keep }, (_, i) => lines[Math.floor(i * lines.length / keep)])
}

function formatPairLine (p) {
  return `- 相手: 「${p.partner.replace(/\n/g, ' ')}」 → 本人: 「${p.reply.replace(/\n/g, ' ')}」`
}

// Loads YouTube spoken-language utterances from solo public captions (cached per video ID) and
// speaker-attributed quotes in already-stored solo video summaries. Always degrades safely to empty arrays.
async function loadYouTubeSpoken (videos, { captionFetch = youtubeCaptions.fetchVideoCaptions, captionDelayMs = CAPTION_FETCH_DELAY_MS } = {}) {
  const spokenLines = []
  const seenSpoken = new Set()
  const addSpoken = (text, label) => {
    const cleaned = String(text || '').trim()
    if (!cleaned || seenSpoken.has(cleaned)) return
    seenSpoken.add(cleaned)
    spokenLines.push(`[${label}] ${cleaned}`)
  }

  if (process.env.YOUTUBE_STYLE_CAPTIONS !== 'false') {
    const targets = youtubeCaptions.selectVideosForCaptions(videos, MAX_CAPTION_VIDEOS)
    for (let i = 0; i < targets.length; i++) {
      if (i > 0 && captionDelayMs > 0) await sleep(captionDelayMs)
      const res = await Promise.resolve(captionFetch(targets[i].video_id)).catch(() => null)
      const label = res?.isAuto ? 'YouTube自動字幕' : 'YouTube字幕'
      for (const u of res?.utterances || []) addSpoken(u, label)
    }
  }

  for (const v of videos || []) {
    if (!v?.summary || COLLAB_VIDEO_TITLE_RE.test(String(v?.title || ''))) continue
    for (const q of youtubeCaptions.extractQuotedSpeechFromSummary(v.summary, { maxQuotes: 4 })) {
      addSpoken(q, 'YouTube要約の台詞')
    }
  }

  return { spokenLines: fitLines(spokenLines, MAX_SPOKEN_CORPUS_CHARS), spokenCount: seenSpoken.size }
}

// Reads the streamer's public utterances, 2-turn Discord reply pairs, and YouTube spoken-language
// excerpts. In Discord, restricts to channels @everyone can read when the guild is cached in memory.
async function loadCorpus ({ captionFetch = youtubeCaptions.fetchVideoCaptions, captionDelayMs = CAPTION_FETCH_DELAY_MS } = {}) {
  const twitter = require('./twitterKnowledge')
  const discord = require('./discordKnowledge')
  const wiki = require('./wikiKnowledge')

  const [rawDiscord, rawPairs, rawX, rawReviews, rawQuotes, rawVideos] = await Promise.all([
    discord.enabled()
      ? discordPosts.recentPosts(ownerGuildIDs(), discord.users(), 200).catch(() => [])
      : Promise.resolve([]),
    discord.enabled() && typeof discordPosts.recentReplyPairs === 'function'
      ? discordPosts.recentReplyPairs(ownerGuildIDs(), discord.users(), 120).catch(() => [])
      : Promise.resolve([]),
    twitter.enabled()
      ? xPosts.recentPosts(twitter.accounts(), 200).catch(() => [])
      : Promise.resolve([]),
    steamAccounts().length
      ? steamDB.getReviews(40).catch(() => [])
      : Promise.resolve([]),
    wiki.enabled() && typeof wikiStore.quoteFacts === 'function'
      ? wikiStore.quoteFacts(MAX_QUOTES * 2).catch(() => [])
      : Promise.resolve([]),
    youtubeChannels().length && typeof youtubeDB.recentVideosForStyle === 'function'
      ? youtubeDB.recentVideosForStyle(20).catch(() => [])
      : Promise.resolve([])
  ])

  const isPublicDiscord = row => {
    const g = global.bot?.guilds?.get?.(row.guild_id)
    if (!g) return true
    const ch = g.channels?.get?.(row.channel_id)
    return !!(ch && discord.everyoneCanRead(g, ch))
  }

  const publicDiscord = (rawDiscord || []).filter(isPublicDiscord)
  const botUserID = global.bot?.user?.id || null
  const publicPairs = (rawPairs || []).filter(p => isPublicDiscord(p) && (!botUserID || p.partner_id !== botUserID))

  const casual = []
  const labeledLines = []
  const seen = new Set()
  const addUtterance = (raw, label, meta) => {
    const cleaned = cleanUtterance(raw)
    if (!cleaned || seen.has(cleaned)) return
    seen.add(cleaned)
    labeledLines.push(`[${label}] ${cleaned.replace(/\n/g, ' ')}`)
    const score = utteranceSalience(cleaned, meta)
    if (score > 0) casual.push({ text: cleaned, score })
  }

  for (const p of publicDiscord) addUtterance(p.content, 'Discord', { source: 'discord', isReply: false })
  for (const p of rawX || []) addUtterance(p.text, p.reply_to ? 'X返信' : 'X', { source: 'x', isReply: !!p.reply_to })
  for (const r of rawReviews || []) addUtterance(r.content, 'Steamレビュー', { source: 'steam', isReply: false })

  const pairCandidates = []
  for (const p of publicPairs) {
    const partner = cleanPartnerPrompt(p.partner_content)
    const reply = cleanUtterance(p.reply_content)
    if (!partner || !reply) continue
    addUtterance(reply, 'Discord返信', { source: 'discord', isReply: true })
    const score = pairSalience({ partner, reply, explicit: Boolean(p.explicit) })
    if (score > 0) pairCandidates.push({ partner, reply, score })
  }

  const allUtterances = [...seen]
  const quantitative = computeStylometrics(allUtterances)
  const rates = inferMarkerRates({ quantitative })

  pairCandidates.sort((a, b) => b.score - a.score)
  const dialoguePairs = diversifyPairs(pairCandidates, MAX_PAIR_POOL, { rates })

  const { spokenLines, spokenCount } = (rawVideos || []).length
    ? await loadYouTubeSpoken(rawVideos, { captionFetch, captionDelayMs })
    : { spokenLines: [], spokenCount: 0 }

  const quotes = (rawQuotes || [])
    .filter(q =>
      q?.name &&
      !NON_SELF_QUOTE_RE.test(String(q.content || '')) &&
      !looksLikeInjection(`${q.name}\n${q.content || ''}`) &&
      !isUnsafeMinorContent(`${q.name}\n${q.content || ''}`)
    )
    .slice(0, MAX_QUOTES)
    .map(q => `- 「${String(q.name).trim().slice(0, 80)}」${q.content ? `: ${String(q.content).trim().slice(0, 100)}` : ''}`)

  casual.sort((a, b) => b.score - a.score)
  const exemplars = diversifyUtterances(casual, MAX_EXEMPLAR_POOL, { rates })

  return {
    utteranceCount: seen.size,
    spokenCount,
    totalCount: seen.size + spokenCount,
    quantitative,
    labeledLines: fitLines(labeledLines, MAX_CORPUS_CHARS),
    spokenLines,
    dialoguePairs,
    quotes,
    exemplars
  }
}

function splitForDprf (dialoguePairs) {
  if (process.env.STREAMER_STYLE_DPRF === 'false') {
    return { trainPairs: dialoguePairs, evalPairs: [] }
  }
  if (!Array.isArray(dialoguePairs) || dialoguePairs.length < MIN_DPRF_PAIRS) {
    return { trainPairs: dialoguePairs || [], evalPairs: [] }
  }
  const evalCount = Math.min(MAX_DPRF_EVAL_PAIRS, Math.floor(dialoguePairs.length / 2))
  const evalIndices = new Set()
  for (let i = 0; i < evalCount; i++) {
    evalIndices.add(Math.floor((i * dialoguePairs.length) / evalCount))
  }
  const evalPairs = dialoguePairs.filter((_, idx) => evalIndices.has(idx))
  const trainPairs = dialoguePairs.filter((_, idx) => !evalIndices.has(idx))
  return { trainPairs, evalPairs }
}

function cleanProfileText (content) {
  const text = withoutCharCount(
    (content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim()
  ).slice(0, MAX_PROFILE_CHARS)
  if (!text || looksLikeInjection(text) || isUnsafeMinorContent(text)) return ''
  return text
}

async function synthesizeInitialProfile (corpus, { trainPairs = corpus.dialoguePairs, evalReplySet = new Set(), guildID = null } = {}) {
  const { callGemini, resolveTaskConfig } = require('./eventDrafter')
  const { model, thinking, flex } = await resolveTaskConfig('light', guildID)
  // Exclude held-out DPRF eval replies from Pass 1 so the simulation step is truly out-of-sample.
  const utterances = evalReplySet.size
    ? corpus.labeledLines.filter(line => {
      const body = line.replace(/^\[[^\]]+\]\s*/, '')
      return !evalReplySet.has(body)
    })
    : corpus.labeledLines
  const pairLines = fitLines((trainPairs || []).map(formatPairLine), MAX_PAIR_CORPUS_CHARS)
  const promptText = prompts.render('persona/style', {
    quantitative: corpus.quantitative,
    utterances: utterances.join('\n'),
    pairs: pairLines.join('\n'),
    spoken: (corpus.spokenLines || []).join('\n'),
    quotes: (corpus.quotes || []).join('\n')
  })
  const content = await callGemini(model, {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.2, ...thinking }
  }, { timeoutMs: 2 * 60 * 1000, purpose: 'streamerStyle', ...(flex ? { flex: true } : {}) })
  return cleanProfileText(content)
}

function parseSimulatedReplies (rawText) {
  const text = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed?.replies) ? parsed.replies : (Array.isArray(parsed) ? parsed : [])
    const map = new Map()
    for (const item of list) {
      const idx = Number(item?.index)
      const reply = String(item?.reply || '').trim()
      if (Number.isInteger(idx) && idx >= 1 && reply) map.set(idx, reply.slice(0, 220))
    }
    return map
  } catch (_) {
    return new Map()
  }
}

// DPRF Pass 2: generates simulated replies for held-out partner prompts using ONLY the initial
// profile, in a single batched JSON call.
async function simulateReplies (profile, evalPairs, guildID = null) {
  const { callGemini, resolveTaskConfig } = require('./eventDrafter')
  const { model, thinking, flex } = await resolveTaskConfig('light', guildID)
  const promptText = prompts.render('persona/simulate', {
    profile,
    prompts: evalPairs.map((p, i) => `${i + 1}. ${p.partner.replace(/\n/g, ' ')}`).join('\n')
  })
  const content = await callGemini(model, {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          replies: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                index: { type: 'INTEGER' },
                reply: { type: 'STRING' }
              },
              required: ['index', 'reply']
            }
          }
        },
        required: ['replies']
      },
      ...thinking
    }
  }, { timeoutMs: 2 * 60 * 1000, purpose: 'streamerStyle-simulate', ...(flex ? { flex: true } : {}) })
  const raw = (content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
  return parseSimulatedReplies(raw)
}

// DPRF Pass 3: compares simulated replies against the streamer's real replies and revises the
// profile to close tone, ending, punctuation, and reaction-cadence gaps.
async function refineProfile (initialProfile, corpus, evalPairs, simulatedMap, guildID = null) {
  const rows = []
  for (let i = 0; i < evalPairs.length; i++) {
    const sim = simulatedMap.get(i + 1)
    if (!sim) continue
    rows.push([
      `${rows.length + 1}. 相手の発言: 「${evalPairs[i].partner.replace(/\n/g, ' ')}」`,
      `   プロファイルだけで作った返答: 「${sim.replace(/\n/g, ' ')}」`,
      `   配信者本人の実際の返答: 「${evalPairs[i].reply.replace(/\n/g, ' ')}」`
    ].join('\n'))
  }
  if (rows.length < 2) return initialProfile
  const { callGemini, resolveTaskConfig } = require('./eventDrafter')
  const { model, thinking, flex } = await resolveTaskConfig('light', guildID)
  const promptText = prompts.render('persona/refine', {
    profile: initialProfile,
    quantitative: corpus.quantitative,
    comparisons: rows.join('\n\n')
  })
  const content = await callGemini(model, {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.2, ...thinking }
  }, { timeoutMs: 2 * 60 * 1000, purpose: 'streamerStyle-refine', ...(flex ? { flex: true } : {}) })
  const refined = cleanProfileText(content)
  return refined.length >= 40 ? refined : initialProfile
}

async function synthesizeProfile (corpus, guildID = null) {
  const { trainPairs, evalPairs } = splitForDprf(corpus.dialoguePairs || [])
  const evalReplySet = new Set(evalPairs.map(p => p.reply.replace(/\n/g, ' ')))
  const initial = await synthesizeInitialProfile(corpus, { trainPairs, evalReplySet, guildID })
  if (!initial || !evalPairs.length) return { profile: initial, refined: false }
  try {
    const simulated = await simulateReplies(initial, evalPairs, guildID)
    if (simulated.size < 2) return { profile: initial, refined: false }
    const refined = await refineProfile(initial, corpus, evalPairs, simulated, guildID)
    return { profile: refined || initial, refined: Boolean(refined && refined !== initial) }
  } catch (e) {
    global.logger?.warn(`[PERSONA]: DPRF refinement skipped, keeping initial profile: ${e.message}`)
    return { profile: initial, refined: false }
  }
}

function promptHash () {
  const combined = [
    prompts.render('persona/style', { quantitative: 'q', utterances: 'u', pairs: 'p', spoken: 's', quotes: '' }),
    prompts.render('persona/simulate', { profile: 'p', prompts: 'q' }),
    prompts.render('persona/refine', { profile: 'p', quantitative: 'q', comparisons: 'c' })
  ].join('\n---\n')
  return hashOf(combined).slice(0, 8)
}

function isFreshEntry (entry, currentPromptHash) {
  if (!entry) return false
  const sh = String(entry.sourceHash || '')
  // Real entries generated by refresh() carry `<8-hex promptHash>:<24-hex corpusHash>`; reject
  // persisted rows from an older prompt version while allowing synthetic test fixtures.
  if (REAL_SOURCE_HASH_RE.test(sh) && !sh.startsWith(`${currentPromptHash}:`)) return false
  return true
}

async function loadPersisted () {
  const pHash = promptHash()
  if (memoryEntry && Date.now() - memoryLoadedAt < MEMORY_TTL_MS && isFreshEntry(memoryEntry, pHash)) {
    return memoryEntry
  }
  const fromRedis = await aiCache.getJson(REDIS_KEY)
  if (fromRedis && isFreshEntry(fromRedis, pHash)) {
    memoryEntry = fromRedis
    memoryLoadedAt = Date.now()
    return fromRedis
  }
  const fromDb = typeof styleStore.getStyle === 'function'
    ? await styleStore.getStyle(STYLE_KEY).catch(() => null)
    : null
  if (fromDb && isFreshEntry(fromDb, pHash)) {
    memoryEntry = fromDb
    memoryLoadedAt = Date.now()
    await aiCache.setJson(REDIS_KEY, fromDb, REDIS_TTL_SECONDS)
    return fromDb
  }
  memoryEntry = null
  return null
}

async function persistEntry (entry) {
  memoryEntry = entry
  memoryLoadedAt = Date.now()
  await Promise.all([
    aiCache.setJson(REDIS_KEY, entry, REDIS_TTL_SECONDS),
    typeof styleStore.saveStyle === 'function'
      ? styleStore.saveStyle(entry, STYLE_KEY).catch(e => global.logger?.warn(`[PERSONA]: Could not persist streamer style to Postgres: ${e.message}`))
      : Promise.resolve()
  ])
}

// Rebuilds the streamer's style profile and exemplar pool when the prompt changed, cache expired,
// or `force` is set. Safe to call concurrently: shares a single in-flight promise.
function refresh ({ force = false, guildID = null, now = Date.now(), captionFetch = youtubeCaptions.fetchVideoCaptions, captionDelayMs = CAPTION_FETCH_DELAY_MS } = {}) {
  if (!enabled() || !isGatewayConfigured()) return Promise.resolve(null)
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const pHash = promptHash()
      const existing = await loadPersisted()
      if (!force && existing?.profile && String(existing.sourceHash || '').startsWith(`${pHash}:`) && now - (existing.updatedAt || 0) < REFRESH_INTERVAL_MS) {
        return existing
      }
      const corpus = await loadCorpus({ captionFetch, captionDelayMs })
      if (corpus.totalCount < MIN_UTTERANCES_FOR_PROFILE) return existing || null
      const cHash = `${pHash}:${hashOf([
        corpus.labeledLines.join('\n'),
        corpus.dialoguePairs.map(formatPairLine).join('\n'),
        corpus.spokenLines.join('\n'),
        corpus.quotes.join('\n')
      ].join('\n===\n'))}`
      if (!force && existing?.profile && existing.sourceHash === cHash) {
        const touched = {
          ...existing,
          exemplars: corpus.exemplars,
          dialoguePairs: corpus.dialoguePairs,
          quantitative: corpus.quantitative,
          updatedAt: now
        }
        await persistEntry(touched)
        return touched
      }
      const { profile, refined } = await synthesizeProfile(corpus, guildID)
      if (!profile) return existing || null
      const entry = {
        profile,
        quantitative: corpus.quantitative,
        exemplars: corpus.exemplars,
        dialoguePairs: corpus.dialoguePairs,
        sourceHash: cHash,
        updatedAt: now
      }
      await persistEntry(entry)
      global.logger?.info(`[PERSONA]: Updated streamer speaking-style profile from ${corpus.utteranceCount} text utterance(s), ${corpus.dialoguePairs.length} dialogue pair(s), ${corpus.spokenCount} YouTube spoken line(s)${refined ? ' (DPRF refined)' : ''}`)
      return entry
    } catch (e) {
      global.logger?.warn(`[PERSONA]: Could not build streamer speaking-style profile: ${e.message}`)
      return memoryEntry
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

// Extracts clean individual streamer utterances from embedded month-section text (discordKnowledge / xKnowledge).
function utterancesFromSections (sections) {
  const out = []
  for (const s of sections || []) {
    for (const line of String(s?.text || '').split('\n')) {
      const m = line.match(SECTION_LINE_RE)
      const cleaned = cleanUtterance(m ? m[1] : line)
      if (cleaned && [...cleaned].length >= 10 && [...cleaned].length <= 140) {
        out.push({ text: cleaned, score: 1 + (s.score || 0) })
      }
    }
  }
  return out
}

// Situationally close real utterances of the streamer when a query embedding is already available.
async function situationalExemplars (vector, limit = 2) {
  if (!vector) return []
  const current = embeddingModel()
  const stores = [discordKnowledgeStore, xKnowledgeStore].filter(s => typeof s?.nearestSections === 'function')
  if (!stores.length) return []
  const found = (await Promise.all(stores.map(s => s.nearestSections(vector, current, 3).catch(() => [])))).flat()
  const close = relevant(found, { min: 0.58, limit: 3 })
  if (!close.length) return []
  return diversifyUtterances(utterancesFromSections(close), limit)
}

// Synchronous read of the L1-cached profile text (used by replyPolish so it never adds an extra round-trip).
function cachedProfile () {
  return memoryEntry?.profile || null
}

// Loads any persisted profile from Redis/Postgres into L1 memory on worker startup so non-shard-0
// workers and restarts immediately have the profile before the first mention arrives.
async function warmCache () {
  if (!enabled()) return null
  return loadPersisted().catch(() => null)
}

// Lines for `describeServer` and `callUncensored` when `streamerPersona` is on: the cached Text
// Style Definition + quantitative balance + 2-3 real 2-turn dialogue pairs + 2-3 diverse verbatim
// everyday utterances, gated so rare slang/laugh markers (`草`, `w`, `だぜ`) are never overrepresented.
async function sectionForPrompt ({ vector = null, vectorOf = null, slim = false, query = '' } = {}) {
  if (!enabled()) return []
  const entry = await loadPersisted()
  if (!entry?.profile && !entry?.exemplars?.length && !entry?.dialoguePairs?.length) return []

  const rates = inferMarkerRates(entry)
  const used = { kusa: 0, w: 0, daze: 0 }

  const pairTarget = slim ? 2 : 3
  const pickedPairs = pickDialoguePairs(entry.dialoguePairs || [], pairTarget, { query, rates, used })
  const pairReplies = new Set(pickedPairs.map(p => p.reply))

  const exemplarTarget = pickedPairs.length ? (slim ? 2 : 3) : (slim ? 3 : 4)
  const resolvedVec = (!slim && (vector || typeof vectorOf === 'function'))
    ? (vector || await Promise.resolve(vectorOf()).catch(() => null))
    : null
  const close = resolvedVec ? await situationalExemplars(resolvedVec, 2).catch(() => []) : []
  const combined = [
    ...close.map(text => ({ text, score: 1.5 })),
    ...(entry.exemplars || []).map((text, idx) => ({ text, score: Math.max(0.5, 1.2 - idx * 0.02) }))
  ].filter(item => !pairReplies.has(item.text))
  const picked = diversifyUtterances(combined, exemplarTarget, { rates, used })

  const lines = ['### 配信者本人の話し方（Discord・X・YouTube・レビューより）']
  if (entry.profile) lines.push(entry.profile)
  if (entry.quantitative) {
    lines.push('実測の文体バランス（特定の語尾や笑い表記をこの頻度以上に連発しないこと）:', entry.quantitative)
  }
  if (pickedPairs.length) {
    lines.push(
      '実際のやり取りの例（距離感・文の長さ・テンポの見本。例の中の特定の語尾や笑い表記を毎文まねたり、過去の話題・固有名詞を今の返事に混ぜたりしないこと）:',
      ...pickedPairs.map(formatPairLine)
    )
  }
  if (picked.length) {
    lines.push(
      '本人の普段の発言例（落ち着いた温度感・文のリズムの見本。ここにある過去の話題や固有名詞は今の返事に混ぜないこと）:',
      ...picked.map(u => `- 「${u.replace(/\n/g, ' ')}」`)
    )
  }
  return lines
}

function startStyle () {
  if (!enabled()) return
  warmCache()
  const run = () => refresh().catch(e => global.logger?.warn(`[PERSONA]: Style refresh failed: ${e.message}`))
  setTimeout(run, STARTUP_REFRESH_DELAY_MS).unref?.()
  setInterval(run, REFRESH_INTERVAL_MS).unref?.()
}

function clearCache ({ memoryOnly = false } = {}) {
  memoryEntry = null
  memoryLoadedAt = 0
  if (!memoryOnly) {
    aiCache.del(REDIS_KEY)
    if (typeof styleStore.deleteStyle === 'function') styleStore.deleteStyle(STYLE_KEY).catch(() => {})
  }
}

module.exports = {
  enabled,
  cleanUtterance,
  cleanPartnerPrompt,
  utteranceSalience,
  pairSalience,
  diversifyUtterances,
  diversifyPairs,
  classifySpeechAct,
  pickDialoguePairs,
  computeStylometrics,
  loadCorpus,
  refresh,
  warmCache,
  startStyle,
  cachedProfile,
  sectionForPrompt,
  clearCache,
  MIN_UTTERANCES_FOR_PROFILE,
  MIN_DPRF_PAIRS
}
