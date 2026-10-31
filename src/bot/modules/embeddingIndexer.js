// Keeps embeddings up to date in the background: every stored YouTube video (title, description
// and summary, redone when any of them changes) and, when MESSAGE_EMBEDDINGS=true, every stored
// message. One worker runs it for all servers, like the retention sweep.
const crypto = require('crypto')
const { embed, model } = require('../utils/embeddings')
const store = require('../../db/interfaces/postgres/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')

const DEFAULT_INTERVAL_MINUTES = 5
// Per run, so a first run over a large history spreads over many runs instead of one long burst.
const MESSAGES_PER_RUN = 1000
const VIDEOS_PER_RUN = 500

function messageEmbeddingsEnabled () {
  return process.env.MESSAGE_EMBEDDINGS === 'true'
}

function intervalMinutes () {
  const raw = process.env.EMBEDDING_INTERVAL_MINUTES
  const minutes = Number(raw)
  return raw && Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_INTERVAL_MINUTES
}

function videoText (v) {
  return [v.title, v.description, v.summary && `内容の要約: ${v.summary}`].filter(Boolean).join('\n')
}

function hashOf (text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
}

// Embeds videos that have no embedding, whose text changed, or that were embedded by another
// model (the hash covers the model too). Resolves to how many were embedded.
async function indexVideos () {
  const current = model()
  const changed = (await store.videosForEmbedding())
    .map(v => ({ ...v, text: videoText(v), hash: hashOf(`${current}\n${videoText(v)}`) }))
    .filter(v => v.text_hash !== v.hash)
    .slice(0, VIDEOS_PER_RUN)
  if (changed.length === 0) return 0
  const vectors = await embed(changed.map(v => v.text))
  for (const [i, v] of changed.entries()) await store.saveVideoEmbedding(v.video_id, vectors[i], v.hash, current)
  return changed.length
}

// The text as people wrote it; stored content is escaped for log embeds.
function plainText (stored) {
  const { fromStoredContent } = require('../../db/interfaces/postgres/create')
  return fromStoredContent(stored).trim()
}

// Embeds the newest messages not handled yet, after sending those embedded by another model back
// to be done again. Resolves to how many were embedded.
async function indexMessages () {
  const reset = await store.resetStaleMessageEmbeddings(model(), MESSAGES_PER_RUN)
  if (reset) global.logger.info(`[EMBEDDINGS]: ${reset} message(s) were embedded by another model and will be embedded again`)
  const pending = await store.pendingMessages(MESSAGES_PER_RUN)
  if (pending.length === 0) return 0
  // Messages from before channels were recorded can't be searched by channel; empty ones say
  // nothing. Both are only marked as handled.
  const wanted = pending.map(m => ({ ...m, text: plainText(m.content) })).filter(m => m.text && m.channel_id && m.guild_id)
  const vectors = wanted.length ? await embed(wanted.map(m => m.text)) : []
  await store.saveMessageEmbeddings(
    wanted.map((m, i) => ({ id: m.id, embedding: vectors[i], model: model() })),
    pending.map(m => m.id))
  return wanted.length
}

let running = false
async function runOnce () {
  if (running) return
  running = true
  try {
    const videos = await indexVideos()
    const messages = messageEmbeddingsEnabled() ? await indexMessages() : 0
    if (videos || messages) global.logger.info(`[EMBEDDINGS]: Embedded ${videos} video(s) and ${messages} message(s)`)
  } catch (e) {
    global.logger.warn(`[EMBEDDINGS]: Indexing failed, trying again next time: ${e.message}`)
  } finally {
    running = false
  }
}

function startIndexer () {
  const minutes = intervalMinutes()
  if (!isGatewayConfigured() || minutes === 0) return null
  global.logger.startup(`[EMBEDDINGS]: Embedding YouTube videos${messageEmbeddingsEnabled() ? ' and messages' : ''} every ${minutes} minutes.`)
  runOnce()
  return setInterval(runOnce, minutes * 60 * 1000)
}

module.exports = { startIndexer, runOnce, indexVideos, indexMessages, messageEmbeddingsEnabled, videoText, hashOf }
