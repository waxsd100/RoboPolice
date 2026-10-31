// Searching stored messages and YouTube videos by meaning, with the embeddings embeddingIndexer
// keeps. Keyword matches still count: a result that contains every word of the query ranks above
// one that is only close in meaning.
const { embedQuery, model } = require('../utils/embeddings')
const store = require('../../db/interfaces/postgres/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')

const KEYWORD_BONUS = 0.15

const wordsOf = query => String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
const matchesAll = (words, text) => words.length !== 0 && words.every(w => text.toLowerCase().includes(w))

// The stored messages of `channelIDs` closest in meaning to `query`, best first:
// [{ id, author_id, channel_id, ts, content, score }]. Content is the text as written.
async function searchMessages (guildID, channelIDs, query, { limit = 30 } = {}) {
  const q = await embedQuery(query)
  // Twice as many: keyword matches are only known once the text is read.
  const nearest = await store.nearestMessages(guildID, channelIDs, q, { model: model(), limit: limit * 2 })
  const scores = new Map(nearest.map(r => [r.message_id, r.score]))
  const words = wordsOf(query)
  return (await store.getMessages([...scores.keys()]))
    .map(m => {
      const content = fromStoredContent(m.content)
      return { ...m, content, score: scores.get(m.id) + (matchesAll(words, content) ? KEYWORD_BONUS : 0) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// `videos` ordered by closeness to `query`, or null when the server's videos have no embeddings
// yet (the caller then falls back to keywords).
async function rankVideos (guildID, videos, query) {
  // Only vectors from the current model: while a model change is being worked through, the rest wait.
  if (!await store.hasVideoEmbeddings(guildID, model())) return null
  const q = await embedQuery(query)
  const scores = await store.videoScores(guildID, q, model())
  const words = wordsOf(query)
  return videos
    .map(v => ({
      video: v,
      score: (scores[v.video_id] || 0) +
        (matchesAll(words, `${v.title}\n${v.description || ''}\n${v.summary || ''}`) ? KEYWORD_BONUS : 0)
    }))
    .sort((a, b) => b.score - a.score)
    .map(r => r.video)
}

module.exports = { searchMessages, rankVideos, KEYWORD_BONUS }
