// The knowledge tables: pages split in parts, each part embedded, and the knowledge taken out of
// each part (migrations/030_normalize.sql, 052_consolidate_tables.sql): knowledge_pages /
// knowledge_sections / knowledge_facts (with knowledge_fact_aliases), one set for every source,
// which is part of each key: the wiki (wikiKnowledge.js), the X posts (twitterKnowledge.js),
// the streamer's Discord messages (discordKnowledge.js) and topics on the web (webKnowledge.js).
// createStore(source) works on one source.
const crypto = require('crypto')
const pool = require('../../clients/postgres')
const { toVectorLiteral } = require('../../../bot/utils/embeddings')

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)

// A fact's aliases, in order, as an array.
const ALIASES = `coalesce((SELECT array_agg(a.alias ORDER BY a.alias_position) FROM knowledge_fact_aliases a
  WHERE a.fact_id = f.id), '{}')`

function createStore (source) {
  // Stores a page as read now: [{ heading, text, images }] in order. Parts that did not change keep
  // their embedding.
  async function savePage (url, title, sections) {
    const client = await pool.getPostgresClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO knowledge_pages (source, url, title, fetched_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (source, url) DO UPDATE SET title = $3, fetched_at = now()`,
        [source, url, title])
      for (const [position, s] of sections.entries()) {
        const hash = hashOf(`${s.heading}\n${s.text}`)
        const imageUrl = (s.images || []).find(Boolean) || null
        await client.query(
          `INSERT INTO knowledge_sections (source, url, position, heading, text, text_hash, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source, url, position) DO UPDATE SET heading = $4, text = $5, text_hash = $6, image_url = $7,
             embedding = CASE WHEN knowledge_sections.text_hash = $6 THEN knowledge_sections.embedding END,
             embedding_model = CASE WHEN knowledge_sections.text_hash = $6 THEN knowledge_sections.embedding_model END`,
          [source, url, position, s.heading, s.text, hash, imageUrl])
      }
      await client.query('DELETE FROM knowledge_sections WHERE source = $1 AND url = $2 AND position >= $3', [source, url, sections.length])
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
    const result = await pool.query('DELETE FROM knowledge_pages WHERE source = $1 AND starts_with(url, $2) AND NOT (url = ANY($3))', [source, root, urls])
    return result.rowCount || 0
  }

  // When the wiki at `root` was last read (null if never).
  async function lastRead (root) {
    const rows = await pool.query('SELECT max(fetched_at) AS at FROM knowledge_pages WHERE source = $1 AND starts_with(url, $2)', [source, root])
    return rows.rows[0]?.at || null
  }

  // Parts with no embedding by `model`: [{ url, position, title, heading, text }].
  async function sectionsToEmbed (model, limit) {
    const rows = await pool.query(
      `SELECT s.url, s.position, p.title, s.heading, s.text FROM knowledge_sections s JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url
       WHERE s.source = $1 AND (s.embedding IS NULL OR s.embedding_model IS DISTINCT FROM $2::embedding_model)
       ORDER BY s.url, s.position LIMIT $3`,
      [source, model, limit])
    return rows.rows
  }

  async function saveSectionEmbedding (url, position, embedding, model) {
    await pool.query(
      'UPDATE knowledge_sections SET embedding = $4, embedding_model = $5 WHERE source = $1 AND url = $2 AND position = $3',
      [source, url, position, toVectorLiteral(embedding), model])
  }

  // The `limit` parts closest in meaning to the vector `query`: [{ url, title, heading, text, score }].
  async function nearestSections (query, model, limit) {
    const rows = await pool.query(
      `SELECT s.url, p.title, s.heading, s.text, 1 - (s.embedding <=> $1::halfvec) AS score
       FROM knowledge_sections s JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url
       WHERE s.source = $4 AND s.embedding_model = $2 AND s.embedding IS NOT NULL
       ORDER BY s.embedding <=> $1::halfvec LIMIT $3`,
      [toVectorLiteral(query), model, limit, source])
    return rows.rows.map(r => ({ ...r, score: Number(r.score) }))
  }

  // The characters the wiki describes: the parts of pages whose title has キャラクター, each its
  // heading and the start of its text. [{ heading, text }]
  async function characters (limit = 80) {
    const rows = await pool.query(
      `SELECT s.heading, left(s.text, 120) AS text FROM knowledge_sections s JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url
       WHERE s.source = $2 AND p.title LIKE '%キャラクター%' AND s.heading <> p.title
       ORDER BY p.url, s.position LIMIT $1`,
      [limit, source])
    // A long part is stored in pieces under one heading; the first piece says who it is.
    const seen = new Set()
    return rows.rows.filter(r => !seen.has(r.heading) && seen.add(r.heading))
  }

  // An image of each character the wiki shows one of: the first image in the parts of pages whose
  // title has キャラクター, in the order of the pages. [{ heading, image }]
  async function characterImages (limit = 6) {
    const rows = await pool.query(
      `SELECT s.heading, s.image_url AS image
       FROM knowledge_sections s JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url
       WHERE s.source = $2 AND s.image_url IS NOT NULL AND p.title LIKE '%キャラクター%' AND s.heading <> p.title
       ORDER BY p.url, s.position LIMIT $1`,
      [limit * 3, source])
    const seen = new Set()
    return rows.rows.filter(r => !seen.has(r.heading) && seen.add(r.heading)).slice(0, limit)
  }

  // Parts whose knowledge has not been taken out since they last changed:
  // [{ url, position, title, heading, text, text_hash }].
  async function sectionsToExtract (limit) {
    const rows = await pool.query(
      `SELECT s.url, s.position, p.title, s.heading, s.text, s.text_hash FROM knowledge_sections s JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url
       WHERE s.source = $2 AND s.facts_hash IS DISTINCT FROM s.text_hash
       ORDER BY s.url, s.position LIMIT $1`,
      [limit, source])
    return rows.rows
  }

  // Replaces what was taken out of a part: [{ kind, name, aliases, content }]. Pieces of knowledge
  // that did not change keep their embedding.
  async function saveFacts (url, position, textHash, facts) {
    const client = await pool.getPostgresClient()
    try {
      await client.query('BEGIN')
      const prev = (await client.query(
        `SELECT f.kind, f.name, ${ALIASES} AS aliases, f.content, f.embedding::text AS embedding, f.embedding_model
         FROM knowledge_facts f WHERE f.source = $1 AND f.url = $2 AND f.position = $3`,
        [source, url, position])).rows
      const keyOf = (f, aliases) => `${f.kind}\n${f.name}\n${aliases.join('\n')}\n${f.content}`
      const byKey = new Map(prev.filter(r => r.embedding).map(r => [keyOf(r, r.aliases || []), r]))
      await client.query('DELETE FROM knowledge_facts WHERE source = $1 AND url = $2 AND position = $3', [source, url, position])
      for (const f of facts) {
        const aliases = (f.aliases || []).filter(Boolean)
        const kept = byKey.get(keyOf(f, aliases))
        await client.query(
          `WITH fact AS (
             INSERT INTO knowledge_facts (source, url, position, kind, name, content, embedding, embedding_model)
             VALUES ($1, $2, $3, $4, $5, $6, $8::halfvec, $9) RETURNING id
           )
           INSERT INTO knowledge_fact_aliases (fact_id, alias_position, alias)
           SELECT fact.id, a.n - 1, a.alias FROM fact, unnest($7::text[]) WITH ORDINALITY AS a (alias, n)`,
          [source, url, position, f.kind, f.name, f.content, aliases, kept?.embedding || null, kept?.embedding_model || null])
      }
      await client.query('UPDATE knowledge_sections SET facts_hash = $4 WHERE source = $1 AND url = $2 AND position = $3', [source, url, position, textHash])
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
      `SELECT f.id, f.kind, f.name, ${ALIASES} AS aliases, f.content FROM knowledge_facts f
       WHERE f.source = $3 AND (f.embedding IS NULL OR f.embedding_model IS DISTINCT FROM $1::embedding_model) ORDER BY f.id LIMIT $2`,
      [model, limit, source])
    return rows.rows
  }

  async function saveFactEmbedding (id, embedding, model) {
    await pool.query('UPDATE knowledge_facts SET embedding = $2, embedding_model = $3 WHERE id = $1', [id, toVectorLiteral(embedding), model])
  }

  // The `limit` pieces of knowledge closest in meaning to the vector `query`, with where they come
  // from: [{ kind, name, aliases, content, url, title, heading, score }].
  async function nearestFacts (query, model, limit) {
    const rows = await pool.query(
      `SELECT f.kind, f.name, ${ALIASES} AS aliases, f.content, f.url, p.title, s.heading, 1 - (f.embedding <=> $1::halfvec) AS score
       FROM knowledge_facts f
       JOIN knowledge_sections s ON s.source = f.source AND s.url = f.url AND s.position = f.position
       JOIN knowledge_pages p ON p.source = f.source AND p.url = f.url
       WHERE f.source = $4 AND f.embedding_model = $2 AND f.embedding IS NOT NULL
       ORDER BY f.embedding <=> $1::halfvec LIMIT $3`,
      [toVectorLiteral(query), model, limit, source])
    return rows.rows.map(r => ({ ...r, score: Number(r.score) }))
  }

  // The characters the wiki's knowledge names, one per name: [{ name, aliases, content }].
  async function characterFacts (limit = 100) {
    const rows = await pool.query(
      `SELECT DISTINCT ON (f.name) f.name, ${ALIASES} AS aliases, f.content FROM knowledge_facts f
       WHERE f.source = $2 AND f.kind = 'character'
       ORDER BY f.name, length(f.content) DESC, f.content LIMIT $1`,
      [limit, source])
    return rows.rows
  }

  async function hasSections () {
    const rows = await pool.query('SELECT 1 FROM knowledge_sections WHERE source = $1 LIMIT 1', [source])
    return rows.rows.length !== 0
  }

  return { savePage, deletePagesExcept, lastRead, sectionsToEmbed, saveSectionEmbedding, nearestSections, characters, characterImages, sectionsToExtract, saveFacts, factsToEmbed, saveFactEmbedding, nearestFacts, characterFacts, hasSections }
}

// The wiki's tables.
module.exports = { ...createStore('wiki'), createStore, hashOf }
