// Keeps embeddings up to date in the background: every stored YouTube video (title, description
// and summary, redone when any of them changes) and, when MESSAGE_EMBEDDINGS=true, every stored
// message. One worker runs it for all servers, like the retention sweep.
const crypto = require('crypto')
const { embed, model, submitEmbeddingBatch, embeddingBatchResult, cancelEmbeddingBatch } = require('../utils/embeddings')
const store = require('../../db/interfaces/postgres/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { embeddableText } = require('../utils/messageNoise')

const DEFAULT_INTERVAL_MINUTES = 5
// Per run, so a first run over a large history spreads over many runs instead of one long burst.
const MESSAGES_PER_RUN = 1000
// Messages older than EMBEDDING_BATCH_AFTER_HOURS (default 24; 0 to embed everything right away)
// are embedded through Gemini's Batch API instead: half the price, done within a day. Up to
// EMBEDDING_BATCH_CONCURRENCY batches at a time (default 3), each of at most EMBEDDING_BATCH_SIZE messages (default 2,000) and
// BATCH_MAX_BYTES of text (Gemini takes 20 MB inline). A batch's results come back inline, about 6 KB
// a message (512 numbers as JSON): 2,000 messages are some 12 MB to read back, where 20,000 were over
// 200 MB and did not come back in time.
// Newer ones are embedded right away, so they can be found soon. (Flex inference does not take
// embedding models.)
const DEFAULT_BATCH_AFTER_HOURS = 24
const DEFAULT_BATCH_SIZE = 2000
function batchSize () {
  const n = Number(process.env.EMBEDDING_BATCH_SIZE)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 20000) : DEFAULT_BATCH_SIZE
}
const DEFAULT_BATCH_CONCURRENCY = 3
function batchConcurrency () {
  const n = Number(process.env.EMBEDDING_BATCH_CONCURRENCY)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 20) : DEFAULT_BATCH_CONCURRENCY
}
const BATCH_MAX_BYTES = 10 * 1024 * 1024
const VIDEOS_PER_RUN = 500

function messageEmbeddingsEnabled () {
  return process.env.MESSAGE_EMBEDDINGS === 'true'
}

function batchAfterHours () {
  const raw = process.env.EMBEDDING_BATCH_AFTER_HOURS
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_BATCH_AFTER_HOURS
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
  const hours = batchAfterHours()
  const cutoff = hours ? new Date(Date.now() - hours * 60 * 60 * 1000) : null
  // A batch that cannot be dealt with never holds up the recent messages.
  if (cutoff) await batchPastMessages(cutoff).catch(e => global.logger.warn(`[EMBEDDINGS]: Past messages could not be batched, trying again next time: ${e.message}`))
  const pending = await store.pendingMessages(MESSAGES_PER_RUN, { after: cutoff })
  if (pending.length === 0) return 0
  const wanted = worthEmbedding(pending)
  const vectors = wanted.length ? await embed(wanted.map(m => m.text)) : []
  await store.saveMessageEmbeddings(
    wanted.map((m, i) => ({ id: m.id, embedding: vectors[i], model: model() })),
    pending.map(m => m.id),
    model())
  return wanted.length
}

// Messages embedded before noise was left out (messageNoise.js) are gone over once each time the
// bot starts, CLEANSE_BATCH at a time, and the embeddings of those that are noise dropped: they
// stay handled, so they are not embedded again. Only the noise is written to. Resolves to how many
// were dropped in this batch; `cleansed` is set once the last batch is done.
const CLEANSE_BATCH = 1000
const cleanse = { after: '', cleansed: false, dropped: 0 }
async function cleanseMessages () {
  if (cleanse.cleansed) return 0
  const batch = await store.embeddedMessagesAfter(cleanse.after, CLEANSE_BATCH)
  if (batch.length === 0) {
    cleanse.cleansed = true
    if (cleanse.dropped) global.logger.info(`[EMBEDDINGS]: Dropped the embeddings of ${cleanse.dropped} noise message(s)`)
    return 0
  }
  cleanse.after = batch[batch.length - 1].id
  const dropped = await store.dropMessageEmbeddings(batch.filter(m => !embeddableText(plainText(m.content))).map(m => m.id))
  cleanse.dropped += dropped
  return dropped
}

// Messages from before channels were recorded can't be searched by channel; empty ones and noise
// ("w", a bare link or emoji: messageNoise.js) say nothing. Those are only marked as handled.
function worthEmbedding (pending) {
  return pending.map(m => ({ ...m, text: embeddableText(plainText(m.content)) })).filter(m => m.text && m.channel_id && m.guild_id)
}

// Looks at the running batch of past messages, storing it when done, and sends the next one when
// none is running. Resolves to how many messages a finished batch embedded.
// Gemini keeps a batch for 48 hours; one still not done by MAX_BATCH_HOURS is given up on (asked to
// stop), and its messages sent again. A look that fails is noted on the batch and tried again on the
// next run; Gemini saying it has no such batch (HTTP 400/403/404) gives it up at once.
const MAX_BATCH_HOURS = 50
async function batchPastMessages (cutoff, now = Date.now()) {
  let embedded = 0
  let running = 0
  for (const batch of await store.runningEmbeddingBatches()) {
    const age = batch.created_at ? (now - new Date(batch.created_at).getTime()) / 3600000 : 0
    let result
    try {
      result = await embeddingBatchResult(batch.name)
    } catch (e) {
      const gone = [400, 403, 404].includes(e.status)
      if (!gone && age < MAX_BATCH_HOURS) {
        global.logger.warn(`[EMBEDDINGS]: Could not look at batch ${batch.name} (${Math.round(age)} h old), trying again next time: ${e.message}`)
        await store.noteEmbeddingBatch(batch.name, { error: e.message }).catch(() => {})
        running++
        continue
      }
      result = { state: 'failed', detail: gone ? `not found at Gemini (HTTP ${e.status})` : `unreadable for ${Math.round(age)} h: ${e.message}` }
    }
    if (result.state === 'running') {
      if (age < MAX_BATCH_HOURS) {
        await store.noteEmbeddingBatch(batch.name, { state: result.detail || 'running' }).catch(() => {})
        running++
        continue
      }
      await cancelEmbeddingBatch(batch.name)
      result = { state: 'failed', detail: `${result.detail || 'running'} after ${Math.round(age)} h (given up on)` }
    }
    if (result.state === 'failed') {
      global.logger.warn(`[EMBEDDINGS]: Batch ${batch.name} ended ${result.detail}; its messages will be sent again`)
    } else {
      // Messages Gemini could not embed are marked as handled too, so they are not sent again and again.
      const rows = batch.message_ids.filter(id => result.vectors.has(id)).map(id => ({ id, embedding: result.vectors.get(id), model: batch.model }))
      await store.saveMessageEmbeddings(rows, batch.message_ids, batch.model)
      embedded += rows.length
      global.logger.info(`[EMBEDDINGS]: Batch ${batch.name} done: embedded ${rows.length} past message(s)${result.failed.length ? `, ${result.failed.length} could not be` : ''}`)
    }
    await store.deleteEmbeddingBatch(batch.name)
  }
  // More batches while fewer than EMBEDDING_BATCH_CONCURRENCY run.
  for (; running < batchConcurrency(); running++) {
    if (!await submitPastBatch(cutoff)) break
  }
  return embedded
}

// Sends the next batch of past messages. Resolves to whether one was sent.
async function submitPastBatch (cutoff) {
  const pending = await store.pendingMessages(batchSize(), { before: cutoff })
  if (pending.length === 0) return false
  const wanted = []
  let bytes = 0
  for (const m of worthEmbedding(pending)) {
    bytes += Buffer.byteLength(m.text) + 200
    if (bytes > BATCH_MAX_BYTES) break
    wanted.push(m)
  }
  const sent = new Set(wanted.map(m => m.id))
  // Only marked as handled: nothing to send for them.
  const nothing = pending.filter(m => !sent.has(m.id) && !worthEmbedding([m]).length).map(m => m.id)
  if (nothing.length) await store.saveMessageEmbeddings([], nothing, model())
  if (!wanted.length) return nothing.length !== 0
  const name = await submitEmbeddingBatch(wanted.map(m => m.text), wanted.map(m => m.id))
  await store.saveEmbeddingBatch(name, model(), wanted.map(m => m.id))
  global.logger.info(`[EMBEDDINGS]: Sent ${wanted.length} past message(s) to be embedded in batch ${name}`)
  return true
}

let running = false
async function runOnce () {
  if (running) return
  running = true
  try {
    const videos = await indexVideos()
    const messages = messageEmbeddingsEnabled() ? await indexMessages() : 0
    // A few batches a run, so it is soon done without holding up the rest.
    if (messageEmbeddingsEnabled()) for (let i = 0; i < 10 && !cleanse.cleansed; i++) await cleanseMessages()
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

module.exports = { MAX_BATCH_HOURS, startIndexer, runOnce, indexVideos, indexMessages, batchPastMessages, batchAfterHours, cleanseMessages, cleanse, messageEmbeddingsEnabled, videoText, hashOf }
