// Text embeddings for searching by meaning: Gemini's embedding model through AI Gateway, stored in
// Postgres with pgvector (halfvec), which finds the nearest ones.
//
// Vectors are DIMENSIONS long (the model is trained so a prefix of its output is a usable
// embedding), normalized, and handled in the app as signed bytes (each component times 127).
const { geminiRequest, geminiSend } = require('../modules/eventDrafter')

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001'
const DIMENSIONS = 512
const BATCH_SIZE = 100 // the most batchEmbedContents takes
const MAX_TEXT = 2000

// Vectors from different models can't be compared, so each stored one records the model that made
// it; changing GEMINI_EMBEDDING_MODEL makes everything again (see embeddingIndexer.js).
function model () {
  return process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
}

// Unit length, then each component as an integer in -127..127.
function quantize (values) {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1
  return Int8Array.from(values, v => Math.max(-127, Math.min(127, Math.round((v / norm) * 127))))
}

// gemini-embedding-001 is told what a text is for with taskType; gemini-embedding-2 rejects that
// field and takes the purpose as a prefix of the text instead.
function request (name, text, taskType) {
  const body = String(text).slice(0, MAX_TEXT) || ' '
  if (/^gemini-embedding-001$|^text-embedding-/.test(model())) {
    return { model: name, content: { parts: [{ text: body }] }, taskType, outputDimensionality: DIMENSIONS }
  }
  const prefixed = taskType === 'RETRIEVAL_QUERY' ? `task: search result | query: ${body}` : `title: none | text: ${body}`
  return { model: name, content: { parts: [{ text: prefixed }] }, outputDimensionality: DIMENSIONS }
}

// Embeds `texts` for storing (RETRIEVAL_DOCUMENT) or for searching (RETRIEVAL_QUERY), BATCH_SIZE
// at a time. Resolves to Int8Arrays in the same order.
async function embed (texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const name = `models/${model()}`
  const vectors = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const data = await geminiRequest(model(), 'batchEmbedContents', {
      requests: texts.slice(i, i + BATCH_SIZE).map(text => request(name, text, taskType))
    }, { purpose: 'embedding' })
    vectors.push(...(data.embeddings || []).map(e => quantize(e.values)))
  }
  if (vectors.length !== texts.length) throw new Error(`Embedding returned ${vectors.length} vectors for ${texts.length} texts`)
  return vectors
}

async function embedQuery (text) {
  return (await embed([text], 'RETRIEVAL_QUERY'))[0]
}

// One vector for several texts' vectors, each counting `weights[i]` (e.g. a conversation counting
// more than the message that continues it): their weighted sum, normalized.
function blend (vectors, weights) {
  const sum = new Array(vectors[0].length).fill(0)
  vectors.forEach((v, i) => { for (let d = 0; d < v.length; d++) sum[d] += v[d] * weights[i] })
  return quantize(sum)
}

// Cosine similarity of two quantized unit vectors, -1..1.
function similarity (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (127 * 127)
}

// The vector as pgvector reads it: '[0.1234,-0.5,…]'.
function toVectorLiteral (vector) {
  return `[${Array.from(vector, v => (v / 127).toFixed(4)).join(',')}]`
}

function toBase64 (vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

function fromBase64 (text) {
  const buffer = Buffer.from(text, 'base64')
  return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

// Texts for storing (RETRIEVAL_DOCUMENT), sent to Gemini's Batch API as one batch: half the price,
// done within a day. keys: one per text, to find its vector again. Resolves to the batch's name.
async function submitEmbeddingBatch (texts, keys) {
  const name = `models/${model()}`
  const data = await geminiRequest(model(), 'asyncBatchEmbedContent', {
    batch: {
      displayName: `robopolice-embeddings-${Date.now()}`,
      inputConfig: { requests: { requests: texts.map((text, i) => ({ request: request(name, text, 'RETRIEVAL_DOCUMENT'), metadata: { key: keys[i] } })) } }
    }
  }, { purpose: 'embedding-batch', timeoutMs: 2 * 60 * 1000 })
  const batch = data.name || data.metadata?.name
  if (!/^batches\//.test(batch || '')) throw new Error(`Gemini returned no batch name: ${JSON.stringify(data).slice(0, 300)}`)
  return batch
}

// The batch's state: 'running', 'succeeded' with { vectors: Map(key -> Int8Array), failed: [key] },
// or 'failed' (failed, cancelled or expired at Gemini).
async function embeddingBatchResult (batch) {
  const data = await geminiSend('GET', batch)
  const state = String(data.metadata?.state || data.state || '')
  if (/FAILED|CANCELLED|EXPIRED/.test(state)) return { state: 'failed', detail: state }
  if (!/SUCCEEDED/.test(state)) return { state: 'running' }
  const out = data.response || data.metadata?.output || data.output || data.dest || {}
  const list = out.inlinedResponses?.inlinedResponses || out.inlinedResponses || out.inlinedEmbedContentResponses || []
  const vectors = new Map()
  const failed = []
  for (const r of Array.isArray(list) ? list : []) {
    const key = r.metadata?.key
    const values = r.response?.embedding?.values || r.response?.embeddings?.[0]?.values
    if (key && values?.length) vectors.set(key, quantize(values))
    else if (key) failed.push(key)
  }
  return { state: 'succeeded', vectors, failed }
}

module.exports = { submitEmbeddingBatch, embeddingBatchResult, embed, embedQuery, blend, model, similarity, quantize, toVectorLiteral, toBase64, fromBase64, DIMENSIONS, BATCH_SIZE }
