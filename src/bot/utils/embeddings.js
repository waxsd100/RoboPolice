// Text embeddings for searching by meaning: Gemini's embedding model through AI Gateway, stored
// compactly and compared in Node. No vector database or Postgres extension is needed; at this
// scale (thousands to tens of thousands of rows) a scan is fast enough.
//
// Vectors are DIMENSIONS long (the model is trained so a prefix of its output is a usable
// embedding), normalized, and stored as signed bytes: 512 bytes a row, base64 in a TEXT column.
const { geminiRequest } = require('../modules/eventDrafter')

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

// Embeds `texts` for storing (RETRIEVAL_DOCUMENT) or for searching (RETRIEVAL_QUERY), BATCH_SIZE
// at a time. Resolves to Int8Arrays in the same order.
async function embed (texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const name = `models/${model()}`
  const vectors = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const data = await geminiRequest(model(), 'batchEmbedContents', {
      requests: texts.slice(i, i + BATCH_SIZE).map(text => ({
        model: name,
        content: { parts: [{ text: String(text).slice(0, MAX_TEXT) || ' ' }] },
        taskType,
        outputDimensionality: DIMENSIONS
      }))
    })
    vectors.push(...(data.embeddings || []).map(e => quantize(e.values)))
  }
  if (vectors.length !== texts.length) throw new Error(`Embedding returned ${vectors.length} vectors for ${texts.length} texts`)
  return vectors
}

async function embedQuery (text) {
  return (await embed([text], 'RETRIEVAL_QUERY'))[0]
}

// Cosine similarity of two quantized unit vectors, -1..1.
function similarity (a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (127 * 127)
}

function toBase64 (vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

function fromBase64 (text) {
  const buffer = Buffer.from(text, 'base64')
  return new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

module.exports = { embed, embedQuery, model, similarity, quantize, toBase64, fromBase64, DIMENSIONS, BATCH_SIZE }
