// Persisted speaking-style profile and curated few-shot exemplars of the streamer
// (migrations/064_streamer_style.sql, written by streamerStyle.js). Acts as durable storage behind
// L1 memory and L2 Redis so restarts, Redis outages, and non-shard-0 workers all share the same
// profile immediately.
const pool = require('../../clients/postgres')

const DEFAULT_KEY = 'default'

async function getStyle (key = DEFAULT_KEY) {
  const rows = await pool.query(
    'SELECT profile, quantitative, exemplars, dialogue_pairs, source_hash, updated_at FROM streamer_style WHERE key = $1',
    [key])
  const row = rows.rows[0]
  if (!row) return null
  return {
    profile: row.profile || '',
    quantitative: row.quantitative || '',
    exemplars: Array.isArray(row.exemplars) ? row.exemplars : [],
    dialoguePairs: Array.isArray(row.dialogue_pairs) ? row.dialogue_pairs : [],
    sourceHash: row.source_hash || '',
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0
  }
}

async function saveStyle (entry, key = DEFAULT_KEY) {
  const updatedAt = entry?.updatedAt ? new Date(entry.updatedAt) : new Date()
  await pool.query(
    `INSERT INTO streamer_style (key, profile, quantitative, exemplars, dialogue_pairs, source_hash, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (key) DO UPDATE SET
       profile = EXCLUDED.profile,
       quantitative = EXCLUDED.quantitative,
       exemplars = EXCLUDED.exemplars,
       dialogue_pairs = EXCLUDED.dialogue_pairs,
       source_hash = EXCLUDED.source_hash,
       updated_at = EXCLUDED.updated_at`,
    [
      key,
      String(entry?.profile || ''),
      String(entry?.quantitative || ''),
      JSON.stringify(Array.isArray(entry?.exemplars) ? entry.exemplars : []),
      JSON.stringify(Array.isArray(entry?.dialoguePairs) ? entry.dialoguePairs : []),
      String(entry?.sourceHash || ''),
      updatedAt
    ])
}

async function deleteStyle (key = DEFAULT_KEY) {
  await pool.query('DELETE FROM streamer_style WHERE key = $1', [key])
}

module.exports = { getStyle, saveStyle, deleteStyle, DEFAULT_KEY }
