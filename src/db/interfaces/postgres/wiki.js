// The knowledge tables: pages split in parts, each part embedded, and the knowledge taken out of
// each part. The wiki's are wiki_pages / wiki_sections / wiki_facts (migrations/012_wiki.sql, read
// by wikiKnowledge.js); the X posts' are x_pages / x_sections / x_facts, of the same shape
// (migrations/015_x_knowledge.sql, written by twitterKnowledge.js). createStore(prefix) works on one set.
const crypto = require('crypto')
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')
const { modelId } = require('./embeddings')

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)

function createStore (prefix) {
  const T = { pages: `${prefix}_pages`, sections: `${prefix}_sections`, facts: `${prefix}_facts` }

  // Stores a page as read now: [{ heading, text, images }] in order. Parts that did not change keep
  // their embedding.
  async function savePage (url, title, sections) {
    const client = await pool.getPostgresClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ${T.pages} (url, title, fetched_at) VALUES ($1, $2, now()) ON CONFLICT (url) DO UPDATE SET title = $2, fetched_at = now()`,
        [url, title])
      for (const [position, s] of sections.entries()) {
        const hash = hashOf(`${s.heading}\n${s.text}`)
        await client.query(
          `INSERT INTO ${T.sections} (url, position, heading, text, images, text_hash) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (url, position) DO UPDATE SET heading = $3, text = $4, images = $5, text_hash = $6,
             embedding = CASE WHEN ${T.sections}.text_hash = $6 THEN ${T.sections}.embedding END,
             model_id = CASE WHEN ${T.sections}.text_hash = $6 THEN ${T.sections}.model_id END`,
          [url, position, s.heading, s.text, s.images || [], hash])
      }
      await client.query(`DELETE FROM ${T.sections} WHERE url = $1 AND position >= $2`, [url, sections.length])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  // Deletes the pages of the wiki at `root` that a full read no longer found.
  async function deletePagesExcept (root, urls) {
    const result = await pool.query(`DELETE FROM ${T.pages} WHERE url LIKE $1 AND NOT (url = ANY($2))`, [`${root}%`, urls])
    return result.rowCount || 0
  }

  // When the wiki at `root` was last read (null if never).
  async function lastRead (root) {
    const rows = await pool.query(`SELECT max(fetched_at) AS at FROM ${T.pages} WHERE url LIKE $1`, [`${root}%`])
    return rows.rows[0]?.at || null
  }

  // Parts with no embedding by `model`: [{ url, position, title, heading, text }].
  async function sectionsToEmbed (model, limit) {
    const rows = await pool.query(
      `SELECT s.url, s.position, p.title, s.heading, s.text FROM ${T.sections} s JOIN ${T.pages} p ON p.url = s.url
       WHERE s.embedding IS NULL OR s.model_id IS DISTINCT FROM $1
       ORDER BY s.url, s.position LIMIT $2`,
      [await modelId(model), limit])
    return rows.rows
  }

  async function saveSectionEmbedding (url, position, embedding, model) {
    await pool.query(
      `UPDATE ${T.sections} SET embedding = $3, model_id = $4 WHERE url = $1 AND position = $2`,
      [url, position, toVectorLiteral(embedding), await modelId(model)])
  }

  // The `limit` parts closest in meaning to the vector `query`: [{ url, title, heading, text, score }].
  async function nearestSections (query, model, limit) {
    const rows = await pool.query(
      `SELECT s.url, p.title, s.heading, s.text, 1 - (s.embedding <=> $1::halfvec) AS score
       FROM ${T.sections} s JOIN ${T.pages} p ON p.url = s.url
       WHERE s.model_id = $2 AND s.embedding IS NOT NULL
       ORDER BY s.embedding <=> $1::halfvec LIMIT $3`,
      [toVectorLiteral(query), await modelId(model), limit])
    return rows.rows.map(r => ({ ...r, score: Number(r.score) }))
  }

  // The characters the wiki describes: the parts of pages whose title has キャラクター, each its
  // heading and the start of its text. [{ heading, text }]
  async function characters (limit = 80) {
    const rows = await pool.query(
      `SELECT s.heading, left(s.text, 120) AS text FROM ${T.sections} s JOIN ${T.pages} p ON p.url = s.url
       WHERE p.title LIKE '%キャラクター%' AND s.heading <> p.title
       ORDER BY p.url, s.position LIMIT $1`,
      [limit])
    // A long part is stored in pieces under one heading; the first piece says who it is.
    const seen = new Set()
    return rows.rows.filter(r => !seen.has(r.heading) && seen.add(r.heading))
  }

  // An image of each character the wiki shows one of: the first image in the parts of pages whose
  // title has キャラクター, in the order of the pages. [{ heading, image }]
  async function characterImages (limit = 6) {
    const rows = await pool.query(
      `SELECT s.heading, s.images[1] AS image FROM ${T.sections} s JOIN ${T.pages} p ON p.url = s.url
       WHERE p.title LIKE '%キャラクター%' AND s.heading <> p.title AND cardinality(s.images) > 0
       ORDER BY p.url, s.position LIMIT $1`,
      [limit * 3])
    const seen = new Set()
    return rows.rows.filter(r => !seen.has(r.heading) && seen.add(r.heading)).slice(0, limit)
  }

  // Parts whose knowledge has not been taken out since they last changed:
  // [{ url, position, title, heading, text, text_hash }].
  async function sectionsToExtract (limit) {
    const rows = await pool.query(
      `SELECT s.url, s.position, p.title, s.heading, s.text, s.text_hash FROM ${T.sections} s JOIN ${T.pages} p ON p.url = s.url
       WHERE s.facts_hash IS DISTINCT FROM s.text_hash
       ORDER BY s.url, s.position LIMIT $1`,
      [limit])
    return rows.rows
  }

  // Replaces what was taken out of a part: [{ kind, name, aliases, content }].
  async function saveFacts (url, position, textHash, facts) {
    const client = await pool.getPostgresClient()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM ${T.facts} WHERE url = $1 AND position = $2`, [url, position])
      for (const f of facts) {
        await client.query(
          `INSERT INTO ${T.facts} (url, position, kind, name, aliases, content) VALUES ($1, $2, $3, $4, $5, $6)`,
          [url, position, f.kind, f.name, f.aliases || [], f.content])
      }
      await client.query(`UPDATE ${T.sections} SET facts_hash = $3 WHERE url = $1 AND position = $2`, [url, position, textHash])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  // Knowledge with no embedding by `model`: [{ id, kind, name, aliases, content }].
  async function factsToEmbed (model, limit) {
    const rows = await pool.query(
      `SELECT id, kind, name, aliases, content FROM ${T.facts}
       WHERE embedding IS NULL OR model_id IS DISTINCT FROM $1 ORDER BY id LIMIT $2`,
      [await modelId(model), limit])
    return rows.rows
  }

  async function saveFactEmbedding (id, embedding, model) {
    await pool.query(`UPDATE ${T.facts} SET embedding = $2, model_id = $3 WHERE id = $1`, [id, toVectorLiteral(embedding), await modelId(model)])
  }

  // The `limit` pieces of knowledge closest in meaning to the vector `query`, with where they come
  // from: [{ kind, name, aliases, content, url, title, heading, score }].
  async function nearestFacts (query, model, limit) {
    const rows = await pool.query(
      `SELECT f.kind, f.name, f.aliases, f.content, f.url, p.title, s.heading, 1 - (f.embedding <=> $1::halfvec) AS score
       FROM ${T.facts} f JOIN ${T.sections} s ON s.url = f.url AND s.position = f.position JOIN ${T.pages} p ON p.url = f.url
       WHERE f.model_id = $2 AND f.embedding IS NOT NULL
       ORDER BY f.embedding <=> $1::halfvec LIMIT $3`,
      [toVectorLiteral(query), await modelId(model), limit])
    return rows.rows.map(r => ({ ...r, score: Number(r.score) }))
  }

  // The characters the wiki's knowledge names, one per name: [{ name, aliases, content }].
  async function characterFacts (limit = 100) {
    const rows = await pool.query(
      `SELECT DISTINCT ON (name) name, aliases, content FROM ${T.facts} WHERE kind = 'character'
       ORDER BY name, length(content) DESC, content LIMIT $1`,
      [limit])
    return rows.rows
  }

  async function hasSections () {
    const rows = await pool.query(`SELECT 1 FROM ${T.sections} LIMIT 1`)
    return rows.rows.length !== 0
  }

  return { savePage, deletePagesExcept, lastRead, sectionsToEmbed, saveSectionEmbedding, nearestSections, characters, characterImages, sectionsToExtract, saveFacts, factsToEmbed, saveFactEmbedding, nearestFacts, characterFacts, hasSections }
}

// The wiki's tables.
module.exports = { ...createStore('wiki'), createStore, hashOf }
