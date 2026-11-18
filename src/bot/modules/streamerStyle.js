// How the streamer speaks, learned from the streamer's own first-party corpus (Discord messages in
// the owner's public channels, X posts and replies, Steam reviews, and extracted quotes) so chat
// replies in streamerPersona mode sound like the person rather than a generic YouTuber.
//
// Follows a three-part architecture from role-playing and style-transfer research:
//   1. Stylometric & Text Style Definition (CAT-LLM / Fic2Bot): deterministic punctuation, length
//      and laugh-marker statistics paired with a compact LLM-extracted linguistic & situational
//      reaction profile (CAPS / DPRF), cached in memory and Redis.
//   2. Utterance-level style exemplars (ChatHaruhi / RoleLLM / PICLe): a few short, real everyday
//      utterances chosen for conversational salience and lexical diversity (MMR), decoupled from
//      their old topics so the model copies voice and rhythm without dragging in past subjects.
//   3. Catchphrase gating (RoleLLM / DITTO): famous wiki quotes are separated from everyday chat
//      so they are used sparingly rather than every turn.
const crypto = require('crypto')
const prompts = require('../utils/prompts')
const aiCache = require('../utils/aiCache')
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
const wikiStore = require('../../db/interfaces/postgres/wiki')
const xKnowledgeStore = require('../../db/interfaces/postgres/xKnowledge')
const discordKnowledgeStore = require('../../db/interfaces/postgres/discordKnowledge')

const REDIS_KEY = 'streamer-style:v1'
const REDIS_TTL_SECONDS = 7 * 24 * 60 * 60
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const MIN_UTTERANCES_FOR_PROFILE = 8
const MAX_CORPUS_CHARS = 18000
const MAX_PROFILE_CHARS = 900
const MAX_EXEMPLAR_POOL = 40
const MAX_QUOTES = 20

// Announcements, automated share text, and PR notices do not reflect natural chat cadence.
const ANNOUNCEMENT_NOISE_RE = /(?:動画を投稿しました|動画を公開しました|プレミア公開|配信開始|生放送開始|ライブ配信中|YouTubeに動画を|#PR\b|#提供\b|#案件\b)/i
const SECTION_LINE_RE = /^\[[\d-]+\](?:\s+(?:#\S+:|@\w+\s*への返信:))?\s*(.+)$/

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)

let memoryEntry = null
let refreshing = null

function steamAccounts () {
  return String(knowledgeSetting('STEAM_ACCOUNTS')).split(',').map(s => s.trim()).filter(Boolean)
}

function enabled () {
  const twitter = require('./twitterKnowledge')
  const discord = require('./discordKnowledge')
  const wiki = require('./wikiKnowledge')
  return twitter.enabled() || discord.enabled() || steamAccounts().length !== 0 || wiki.enabled()
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

// Scores how useful a short utterance is as a conversational speaking-style exemplar (PICLe):
// favours natural 12-120 character utterances over telegraphic fragments or wall-of-text notices.
function utteranceSalience (text, { isReply = false, source = 'x' } = {}) {
  const chars = [...String(text || '')].length
  if (chars < 8 || chars > 160) return -1
  let score = 1
  if (chars >= 14 && chars <= 95) score += 0.5
  if (source === 'discord') score += 0.45
  if (isReply) score += 0.3
  if (/[！？!?…ー〜wｗ草笑]$|[だねよかなさぞわねん][！？!?…wｗ草]*$/u.test(text)) score += 0.25
  if (/\n/.test(text) && text.split('\n').length <= 3) score += 0.1
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

// Picks `count` diverse utterances using Maximal Marginal Relevance over salience vs. lexical overlap.
function diversifyUtterances (candidates, count, { lambda = 0.72 } = {}) {
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
      const val = lambda * item.score - (1 - lambda) * overlap
      if (val > bestVal) {
        best = item
        bestVal = val
      }
    }
    if (!best) break
    seen.add(best.text)
    picked.push(best)
  }
  return picked.map(p => p.text)
}

// Objective micro-level stylometric indicators (CAT-LLM / Fic2Bot) computed directly from the
// streamer's casual utterances so the LLM style summary stays anchored in real frequencies.
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
  const wLaugh = utterances.filter(u => /(?:[ぁ-んァ-ヶ一-龠a-z0-9]|^)[wｗ]{1,6}(?:$|[\s!！?？。、])/iu.test(u)).length
  const kusaLaugh = utterances.filter(u => /草/.test(u)).length
  const kakkoLaugh = utterances.filter(u => /[（(]?笑[)）]?$/.test(u)).length
  return [
    `- 分析対象の発言数: ${n}件、1発言の長さ中央値: 約${medianLen}文字、改行を含む発言: ${pct(multiLine)}`,
    `- 句読点・記号を含む割合: 句点「。」${pct(withPeriod)}、読点「、」${pct(withComma)}、感嘆符「!／！」${pct(withExclam)}、疑問符「?／？」${pct(withQuestion)}`,
    `- 笑い表現を含む割合: 「w」${pct(wLaugh)}、「草」${pct(kusaLaugh)}、「笑」${pct(kakkoLaugh)}`
  ].join('\n')
}

function fitLines (lines, maxChars) {
  const total = lines.reduce((sum, l) => sum + l.length + 1, 0)
  if (total <= maxChars) return lines
  const keep = Math.max(1, Math.floor(lines.length * maxChars / total))
  return Array.from({ length: keep }, (_, i) => lines[Math.floor(i * lines.length / keep)])
}

// Reads the streamer's public utterances from Postgres. In Discord, restricts to channels
// @everyone can read when the guild is cached in memory (matching discordKnowledge.js).
async function loadCorpus () {
  const twitter = require('./twitterKnowledge')
  const discord = require('./discordKnowledge')
  const wiki = require('./wikiKnowledge')

  const [rawDiscord, rawX, rawReviews, rawQuotes] = await Promise.all([
    discord.enabled()
      ? discordPosts.recentPosts(ownerGuildIDs(), discord.users(), 200).catch(() => [])
      : Promise.resolve([]),
    twitter.enabled()
      ? xPosts.recentPosts(twitter.accounts(), 200).catch(() => [])
      : Promise.resolve([]),
    steamAccounts().length
      ? steamDB.getReviews(40).catch(() => [])
      : Promise.resolve([]),
    wiki.enabled() && typeof wikiStore.quoteFacts === 'function'
      ? wikiStore.quoteFacts(MAX_QUOTES).catch(() => [])
      : Promise.resolve([])
  ])

  const publicDiscord = rawDiscord.filter(p => {
    const g = global.bot?.guilds?.get?.(p.guild_id)
    if (!g) return true
    const ch = g.channels?.get?.(p.channel_id)
    return !!(ch && discord.everyoneCanRead(g, ch))
  })

  const casual = []
  const labeledLines = []
  const seen = new Set()
  const addUtterance = (raw, label, meta) => {
    const cleaned = cleanUtterance(raw)
    if (!cleaned || seen.has(cleaned)) return
    seen.add(cleaned)
    labeledLines.push(`[${label}] ${cleaned.replace(/\n/g, ' / ')}`)
    const score = utteranceSalience(cleaned, meta)
    if (score > 0) casual.push({ text: cleaned, score })
  }

  for (const p of publicDiscord) addUtterance(p.content, 'Discord', { source: 'discord', isReply: false })
  for (const p of rawX) addUtterance(p.text, p.reply_to ? 'X返信' : 'X', { source: 'x', isReply: !!p.reply_to })
  for (const r of rawReviews) addUtterance(r.content, 'Steamレビュー', { source: 'steam', isReply: false })

  const quotes = (rawQuotes || [])
    .filter(q => q?.name && !looksLikeInjection(`${q.name}\n${q.content || ''}`) && !isUnsafeMinorContent(`${q.name}\n${q.content || ''}`))
    .slice(0, MAX_QUOTES)
    .map(q => `- 「${String(q.name).trim().slice(0, 80)}」${q.content ? `: ${String(q.content).trim().slice(0, 100)}` : ''}`)

  casual.sort((a, b) => b.score - a.score)
  const exemplars = diversifyUtterances(casual, MAX_EXEMPLAR_POOL)

  return {
    utteranceCount: seen.size,
    quantitative: computeStylometrics([...seen]),
    labeledLines: fitLines(labeledLines, MAX_CORPUS_CHARS),
    quotes,
    exemplars
  }
}

async function synthesizeProfile (corpus, guildID = null) {
  const { callGemini, resolveTaskConfig } = require('./eventDrafter')
  const { model, thinking, flex } = await resolveTaskConfig('extract', guildID)
  const promptText = prompts.render('persona/style', {
    quantitative: corpus.quantitative,
    utterances: corpus.labeledLines.join('\n'),
    quotes: corpus.quotes.join('\n')
  })
  const content = await callGemini(model, {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.2, ...thinking }
  }, { timeoutMs: 2 * 60 * 1000, purpose: 'streamerStyle', ...(flex ? { flex: true } : {}) })
  const text = withoutCharCount(content.parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()).slice(0, MAX_PROFILE_CHARS)
  if (!text || looksLikeInjection(text) || isUnsafeMinorContent(text)) return ''
  return text
}

function promptHash () {
  return hashOf(prompts.render('persona/style', { quantitative: 'q', utterances: 'u', quotes: '' })).slice(0, 8)
}

// Rebuilds the streamer's style profile and exemplar pool when the prompt changed, cache expired,
// or `force` is set. Safe to call concurrently: shares a single in-flight promise.
function refresh ({ force = false, guildID = null, now = Date.now() } = {}) {
  if (!enabled() || !isGatewayConfigured()) return Promise.resolve(null)
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const pHash = promptHash()
      const existing = memoryEntry || await aiCache.getJson(REDIS_KEY)
      if (existing) memoryEntry = existing
      if (!force && existing?.profile && String(existing.sourceHash || '').startsWith(`${pHash}:`) && now - (existing.updatedAt || 0) < REFRESH_INTERVAL_MS) {
        return existing
      }
      const corpus = await loadCorpus()
      if (corpus.utteranceCount < MIN_UTTERANCES_FOR_PROFILE) return existing || null
      const cHash = `${pHash}:${hashOf(corpus.labeledLines.join('\n') + '\n' + corpus.quotes.join('\n'))}`
      if (!force && existing?.profile && existing.sourceHash === cHash) {
        const touched = { ...existing, exemplars: corpus.exemplars, quantitative: corpus.quantitative, updatedAt: now }
        memoryEntry = touched
        await aiCache.setJson(REDIS_KEY, touched, REDIS_TTL_SECONDS)
        return touched
      }
      const profile = await synthesizeProfile(corpus, guildID)
      if (!profile) return existing || null
      const entry = {
        profile,
        quantitative: corpus.quantitative,
        exemplars: corpus.exemplars,
        sourceHash: cHash,
        updatedAt: now
      }
      memoryEntry = entry
      await aiCache.setJson(REDIS_KEY, entry, REDIS_TTL_SECONDS)
      global.logger?.info(`[PERSONA]: Updated streamer speaking-style profile from ${corpus.utteranceCount} utterance(s)`)
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

// Lines for `describeServer` when `streamerPersona` is on: the cached Text Style Definition +
// 3-4 diverse verbatim everyday utterances. Purely reads memory / Redis so user mentions and
// tests never trigger background LLM extraction or extra query embeddings when no profile is cached.
async function sectionForPrompt ({ vector = null, vectorOf = null, slim = false } = {}) {
  if (!enabled()) return []
  let entry = memoryEntry
  if (!entry) {
    entry = await aiCache.getJson(REDIS_KEY)
    if (entry) memoryEntry = entry
  }
  if (!entry?.profile && !entry?.exemplars?.length) return []

  const exemplarTarget = slim ? 3 : 4
  const resolvedVec = (!slim && (vector || typeof vectorOf === 'function'))
    ? (vector || await Promise.resolve(vectorOf()).catch(() => null))
    : null
  const close = resolvedVec ? await situationalExemplars(resolvedVec, 2).catch(() => []) : []
  const combined = [
    ...close.map(text => ({ text, score: 1.5 })),
    ...(entry?.exemplars || []).map((text, idx) => ({ text, score: Math.max(0.5, 1.2 - idx * 0.02) }))
  ]
  const picked = diversifyUtterances(combined, exemplarTarget)

  const lines = ['### 配信者本人の話し方（X・Discord・レビューより）']
  if (entry?.profile) lines.push(entry.profile)
  if (picked.length) {
    lines.push(
      '本人の普段の発言例（口調・文のリズム・表記の癖の見本。ここにある過去の話題や固有名詞は今の返事に混ぜないこと）:',
      ...picked.map(u => `- 「${u.replace(/\n/g, ' ')}」`)
    )
  }
  return lines
}

function startStyle () {
  if (!enabled()) return
  const run = () => refresh().catch(e => global.logger?.warn(`[PERSONA]: Style refresh failed: ${e.message}`))
  setTimeout(run, 30 * 1000).unref?.()
  setInterval(run, REFRESH_INTERVAL_MS).unref?.()
}

function clearCache ({ memoryOnly = false } = {}) {
  memoryEntry = null
  if (!memoryOnly) aiCache.del(REDIS_KEY)
}

module.exports = {
  enabled,
  cleanUtterance,
  utteranceSalience,
  diversifyUtterances,
  computeStylometrics,
  loadCorpus,
  refresh,
  startStyle,
  cachedProfile,
  sectionForPrompt,
  clearCache,
  MIN_UTTERANCES_FOR_PROFILE
}
