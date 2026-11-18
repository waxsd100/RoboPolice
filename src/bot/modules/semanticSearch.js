// Searching stored messages and YouTube videos by meaning, with the embeddings embeddingIndexer
// keeps. Keyword matches still count: messages are found both ways and the two rankings fused
// (reciprocal rank fusion), and a video that contains every word of the query ranks above one that
// is only close in meaning.
// Through the module, so a test can stand in for the query's embedding.
const embeddings = require('../utils/embeddings')
const { model, similarity, blend } = embeddings
const store = require('../../db/interfaces/postgres/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')
const { embeddableText } = require('../utils/messageNoise')
const { relevant, WINDOW: SCORE_WINDOW, CLIFF } = require('../utils/relevance')
const { mentionsMinor, isUnsafeMinorContent, MIN_MINOR_RELATED_SCORE, MAX_MINOR_RELATED_ITEMS } = require('../utils/minorSafety')

const KEYWORD_BONUS = 0.15
// Reciprocal rank fusion: a message's score is the sum of 1 / (RRF_K + its rank) in each ranking
// (by meaning, by keyword). 60 is the usual constant; it keeps one ranking's top from outweighing
// both rankings' agreement.
const RRF_K = 60

const wordsOf = query => String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
const matchesAll = (words, text) => words.length !== 0 && words.every(w => text.toLowerCase().includes(w))
const textOf = m => ({ ...m, content: fromStoredContent(m.content) })

// The messages of `channelIDs` found for `query` by meaning and by keyword, fused: { q (the query's
// vector), ranked: [message_id] best first, cosine: Map(id → similarity to the query) }.
async function candidates (guildID, channelIDs, query, limit) {
  const q = await embeddings.embedQuery(query)
  const [nearest, keyword] = await Promise.all([
    store.nearestMessages(guildID, channelIDs, q, { model: model(), limit }),
    store.keywordMessages(guildID, channelIDs, wordsOf(query), { limit })
  ])
  const fused = new Map()
  const add = (id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank + 1))
  nearest.forEach((r, i) => add(r.message_id, i))
  keyword.forEach((r, i) => add(r.message_id, i))
  const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
  return { q, ranked, fused, cosine: new Map(nearest.map(r => [r.message_id, r.score])), byKeyword: new Set(keyword.map(r => r.message_id)) }
}

// The stored messages of `channelIDs` closest to `query`, best first, by meaning and by keyword
// fused: [{ id, author_id, channel_id, ts, content, score }]. Content is the text as written.
// Those found by meaning only as many as are close enough (relevance.js); those holding the words
// all unless `query` contains minor-related terms, where dumping every unrelated keyword match into
// one prompt triggers Google's child-safety classifier.
async function searchMessages (guildID, channelIDs, query, { limit = 30 } = {}) {
  const minorQuery = mentionsMinor(query)
  const effectiveLimit = minorQuery ? Math.min(limit, MAX_MINOR_RELATED_ITEMS * 2) : limit
  const { ranked, fused, cosine, byKeyword } = await candidates(guildID, channelIDs, query, limit * 2)
  const close = new Set(relevant([...cosine.entries()], {
    score: ([, c]) => c,
    ...(minorQuery ? { min: MIN_MINOR_RELATED_SCORE, limit: effectiveLimit } : {})
  }).map(([id]) => id))
  let unembeddedKeywordKept = 0
  const kept = ranked.filter(id => {
    if (close.has(id)) return true
    if (!byKeyword.has(id)) return false
    if (!minorQuery) return true
    // On minor queries, drop embedded messages whose meaning is far from the query, and cap
    // unembedded keyword-only matches so unrelated messages sharing the word never flood the prompt.
    if (cosine.has(id)) return false
    if (unembeddedKeywordKept >= MAX_MINOR_RELATED_ITEMS) return false
    unembeddedKeywordKept++
    return true
  })
  const found = new Map((await store.getMessages(kept)).map(m => [m.id, textOf(m)]))
  return kept
    .map(id => found.get(id))
    // Gone since, unsafe minor co-occurrence, or noise embedded before it was left out (messageNoise.js).
    .filter(m => m && embeddableText(m.content) && !isUnsafeMinorContent(m.content))
    .map(m => ({ ...m, score: fused.get(m.id) }))
    .slice(0, effectiveLimit)
}

// A message shorter than this says little alone (「こどもでーす」): in a conversation it counts for
// less, and alone it is ranked down. Embeddings of very short texts come out close to almost
// anything, so their similarity alone cannot tell what they are about.
const MIN_RELIABLE_CHARS = 10
// Conversations about as close as the best one (within SCORE_WINDOW) are kept, cut where the
// scores drop by CLIFF or more from one to the next: how many is up to the query, not a fixed count
// (relevance.js).
// Maximal marginal relevance: of those kept, each next one is picked for its closeness to the query
// (MMR_LAMBDA) against its closeness to those already picked (1 − MMR_LAMBDA), so five
// conversations saying the same do not crowd out the rest.
const MMR_LAMBDA = 0.7
// How many of the best candidates are turned into conversations to choose from.
const POOL = 15
// What makes up a message's conversation: what it replied to and the replies to it
// (message_replies), and what was said just before and after it in its channel.
const MAX_REPLIES = 3
const MAX_CONVERSATION = 6

const reliability = text => Math.min(1, [...String(text || '').trim()].length / MIN_RELIABLE_CHARS)

// The conversations of `channelIDs` that come closest to `query`, best first: each a message found
// with what it replied to, the replies to it, and what was said just before and after it, so it is
// read as it was meant, not as a phrase out of its talk (a list of short phrases close to one word
// reads as something else entirely: Google refused one). Each is ranked as a whole, by its
// messages' embeddings blended (the message found counting twice, short ones less). How many come
// back is up to the scores (SCORE_WINDOW, CLIFF), at most `limit`, picked for variety (MMR), none
// sharing a message with another.
// [{ hit: { id, author_id, channel_id, ts, content }, messages: [same, oldest first], score }]
async function searchConversations (guildID, channelIDs, query, { limit = 5, before = 1, after = 2, withinSeconds = 30 * 60 } = {}) {
  const minorQuery = mentionsMinor(query)
  const { q, ranked, cosine } = await candidates(guildID, channelIDs, query, POOL * 4)
  const hits = (await store.getMessages(ranked.slice(0, POOL))).map(textOf).filter(m => embeddableText(m.content) && !isUnsafeMinorContent(m.content))
  if (!hits.length) return []
  const order = new Map(ranked.map((id, i) => [id, i]))
  hits.sort((x, y) => order.get(x.id) - order.get(y.id))

  // What each replied to and the replies to it.
  const links = await store.replyLinks(hits.map(h => h.id))
  const parentOf = new Map(links.map(l => [l.message_id, l.reply_to]))
  const repliesTo = new Map()
  for (const l of links) repliesTo.set(l.reply_to, [...(repliesTo.get(l.reply_to) || []), l.message_id])
  const linked = new Map((await store.getMessages([...new Set(links.flatMap(l => [l.message_id, l.reply_to]))])).map(m => [m.id, textOf(m)]))

  const conversations = []
  for (const hit of hits) {
    const around = (await store.messagesAround(hit.channel_id, hit.ts, { before, after, withinSeconds })).map(textOf)
    const parent = linked.get(parentOf.get(hit.id))
    const replies = (repliesTo.get(hit.id) || []).map(id => linked.get(id)).filter(Boolean).slice(0, MAX_REPLIES)
    const byID = new Map()
    // The reply chain first: it is the conversation for certain; the neighbours in time fill in.
    for (const m of [hit, parent, ...replies, ...around]) {
      if (m && !byID.has(m.id) && !isUnsafeMinorContent(m.content) && (m.id === hit.id || embeddableText(m.content)) && byID.size < MAX_CONVERSATION) byID.set(m.id, m)
    }
    conversations.push({ hit, messages: [...byID.values()].sort((x, y) => new Date(x.ts) - new Date(y.ts)) })
  }

  // Each conversation as one vector: its messages' embeddings blended.
  const vectors = await store.messageVectors([...new Set(conversations.flatMap(c => c.messages.map(m => m.id)))], model())
  for (const c of conversations) {
    const parts = c.messages.filter(m => vectors.has(m.id))
    const weights = parts.map(m => reliability(m.content) * (m.id === c.hit.id ? 2 : 1))
    c.vector = parts.length && weights.some(w => w > 0) ? blend(parts.map(m => vectors.get(m.id)), weights) : null
    const alone = c.messages.length === 1
    c.score = (c.vector ? similarity(q, c.vector) : (cosine.get(c.hit.id) ?? 0)) * (alone ? reliability(c.hit.content) : 1)
  }

  // As many as the scores say.
  const kept = relevant(conversations, minorQuery ? { min: MIN_MINOR_RELATED_SCORE } : undefined)

  // For variety, and no message twice.
  const picked = []
  const shown = new Set()
  while (picked.length < limit) {
    let best = null
    let bestValue = -Infinity
    for (const c of kept) {
      if (picked.includes(c) || c.messages.some(m => shown.has(m.id))) continue
      const overlap = picked.length && c.vector ? Math.max(...picked.map(p => p.vector ? similarity(c.vector, p.vector) : 0)) : 0
      const value = MMR_LAMBDA * c.score - (1 - MMR_LAMBDA) * overlap
      if (value > bestValue) {
        best = c
        bestValue = value
      }
    }
    if (!best) break
    picked.push(best)
    for (const m of best.messages) shown.add(m.id)
  }
  return picked.map(({ hit, messages, score }) => ({ hit, messages, score }))
}

// Of `videos`, those that are about `query`, closest first: every one that holds all its words,
// then those close in meaning, as many as are close enough (relevance.js), not the whole list in
// order. Null when the server's videos have no embeddings yet (the caller then falls back to
// keywords).
async function rankVideos (guildID, videos, query) {
  // Only vectors from the current model: while a model change is being worked through, the rest wait.
  if (!await store.hasVideoEmbeddings(guildID, model())) return null
  const q = await embeddings.embedQuery(query)
  const scores = await store.videoScores(guildID, q, model())
  const words = wordsOf(query)
  const minorQuery = mentionsMinor(query)
  const safeVideos = videos.filter(v => !isUnsafeMinorContent(`${v.title}\n${v.description || ''}\n${v.summary || ''}`))
  const scored = safeVideos.map(v => ({
    video: v,
    cosine: scores[v.video_id] || 0,
    keyword: matchesAll(words, `${v.title}\n${v.description || ''}\n${v.summary || ''}`)
  }))
  const byMeaning = relevant(scored, {
    score: r => r.cosine,
    ...(minorQuery ? { min: MIN_MINOR_RELATED_SCORE, limit: MAX_MINOR_RELATED_ITEMS * 2 } : {})
  })
  const keywordHits = scored
    .filter(r => r.keyword && (!minorQuery || r.cosine >= 0.55 || Object.keys(scores).length === 0))
    .sort((a, b) => b.cosine - a.cosine)
  const cappedKeywords = minorQuery ? keywordHits.slice(0, MAX_MINOR_RELATED_ITEMS * 2) : keywordHits
  const pickedIds = new Set(cappedKeywords.map(r => r.video.video_id))
  return [
    ...cappedKeywords,
    ...byMeaning.filter(r => !pickedIds.has(r.video.video_id))
  ].map(r => r.video)
}

module.exports = { searchMessages, searchConversations, rankVideos, KEYWORD_BONUS, RRF_K, MIN_RELIABLE_CHARS, SCORE_WINDOW, CLIFF, MMR_LAMBDA }
