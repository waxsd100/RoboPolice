// Embeddings move from base64 TEXT (512 signed bytes, each a component times 127) to pgvector's
// halfvec(512), so the database finds the nearest ones itself, with an HNSW index, instead of the
// app reading them all. Values that are not 512 components are dropped and made again.
const BATCH = 1000
const DIMENSIONS = 512

function toLiteral (base64) {
  const bytes = Buffer.from(base64 || '', 'base64')
  if (bytes.length !== DIMENSIONS) return null
  return `[${Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), v => (v / 127).toFixed(4)).join(',')}]`
}

async function convert (client, table, key) {
  await client.query(`ALTER TABLE ${table} ADD COLUMN vec halfvec(${DIMENSIONS})`)
  let after = ''
  for (;;) {
    const rows = (await client.query(`SELECT ${key} AS key, embedding FROM ${table} WHERE ${key} > $1 ORDER BY ${key} LIMIT ${BATCH}`, [after])).rows
    if (rows.length === 0) break
    after = rows[rows.length - 1].key
    for (const row of rows) {
      const literal = toLiteral(row.embedding)
      if (literal) await client.query(`UPDATE ${table} SET vec = $2 WHERE ${key} = $1`, [row.key, literal])
    }
  }
  return client.query(`DELETE FROM ${table} WHERE vec IS NULL RETURNING ${key} AS key`)
}

module.exports = async client => {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector')

  const droppedMessages = await convert(client, 'message_embeddings', 'message_id')
  if (droppedMessages.rows.length) await client.query('UPDATE messages SET embedded = false WHERE id = ANY($1)', [droppedMessages.rows.map(r => r.key)])
  // A video without an embedding row is embedded again by the indexer.
  await convert(client, 'youtube_video_embeddings', 'video_id')

  for (const table of ['message_embeddings', 'youtube_video_embeddings']) {
    await client.query(`ALTER TABLE ${table} DROP COLUMN embedding`)
    await client.query(`ALTER TABLE ${table} RENAME COLUMN vec TO embedding`)
    await client.query(`ALTER TABLE ${table} ALTER COLUMN embedding SET NOT NULL`)
    await client.query(`CREATE INDEX ${table}_hnsw ON ${table} USING hnsw (embedding halfvec_cosine_ops)`)
  }
}
