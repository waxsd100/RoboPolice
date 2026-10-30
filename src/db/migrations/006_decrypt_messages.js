// Message content, image URLs and message embeddings were encrypted in the app with AES_KEY. They
// are stored as they are from now on (encryption moves into the database with pgcrypto), so the
// stored values are decrypted here once.
const format = require('pg-format')
const aes = require('../aes')

const BATCH = 1000

function decrypt (value) {
  if (value === null || value === undefined) return value
  try {
    return aes.decrypt(value)
  } catch (_) {
    return value
  }
}

// Decrypts `column` of `table` for every row, BATCH rows at a time in key order.
async function decryptColumn (client, table, keys, column) {
  const keyList = keys.join(', ')
  let after = null
  for (;;) {
    const where = after ? `WHERE (${keyList}) > (${after.map((_, i) => `$${i + 1}`).join(', ')})` : ''
    const rows = (await client.query(
      `SELECT ${keyList}, ${column} AS value FROM ${table} ${where} ORDER BY ${keyList} LIMIT ${BATCH}`,
      after || [])).rows
    if (rows.length === 0) return
    const last = rows[rows.length - 1]
    after = keys.map(k => last[k])
    const values = rows.map(r => [...keys.map(k => String(r[k])), decrypt(r.value)])
    await client.query(format(
      `UPDATE ${table} t SET ${column} = v.value FROM (VALUES %L) v(${keyList}, value) WHERE ${keys.map(k => `t.${k}::text = v.${k}`).join(' AND ')}`,
      values))
  }
}

module.exports = async client => {
  await decryptColumn(client, 'messages', ['id'], 'content')
  await decryptColumn(client, 'message_attachments', ['message_id', 'position'], 'url')
  await decryptColumn(client, 'message_embeddings', ['message_id'], 'embedding')
}
