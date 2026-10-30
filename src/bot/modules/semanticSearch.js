// Searching stored messages and YouTube videos by meaning, with the embeddings embeddingIndexer
// keeps. Keyword matches still count: a result that contains every word of the query ranks above
// one that is only close in meaning.
const { embedQuery, similarity, fromBase64 } = require('../utils/embeddings')
const store = require('../../db/interfaces/postgres/embeddings')
const { fromStoredContent } = require('../../db/interfaces/postgres/create')

const KEYWORD_BONUS = 0.15

const wordsOf = query => String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
const matchesAll = (words, text) => words.length !== 0 && words.every(w => text.toLowerCase().includes(w))

// Keeps the `limit` highest-scoring items as they are offered.
function topK (limit) {
  const items = []
  return {
    offer (item) {
      if (items.length === limit && item.score <= items[items.length - 1].score) return
      items.push(item)
      items.sort((a, b) => b.score - a.score)
      if (items.length > limit) items.pop()
    },
    items
  }
}

// The stored messages of `channelIDs` closest in meaning to `query`, best first:
// [{ id, author_id, channel_id, ts, content, score }]. Content is the text as written.
async function searchMessages (guildID, channelIDs, query, { limit = 30 } = {}) {
  const q = await embedQuery(query)
  const best = topK(limit * 2) // keyword matches are only known once the text is read
  for await (const page of store.messageEmbeddingPages(guildID, channelIDs)) {
    for (const row of page) best.offer({ id: row.message_id, score: similarity(q, fromBase64(row.embedding)) })
  }
  const scores = new Map(best.items.map(i => [i.id, i.score]))
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
  const embeddings = await store.videoEmbeddings(guildID)
  if (Object.keys(embeddings).length === 0) return null
  const q = await embedQuery(query)
  const words = wordsOf(query)
  return videos
    .map(v => ({
      video: v,
      score: (embeddings[v.video_id] ? similarity(q, fromBase64(embeddings[v.video_id])) : 0) +
        (matchesAll(words, `${v.title}\n${v.description || ''}\n${v.summary || ''}`) ? KEYWORD_BONUS : 0)
    }))
    .sort((a, b) => b.score - a.score)
    .map(r => r.video)
}

module.exports = { searchMessages, rankVideos, topK, KEYWORD_BONUS }
