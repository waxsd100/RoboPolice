// A message's images were one column: each URL base64url-encoded, encrypted, and the results joined
// with '|'. They become one row each, the URL encrypted as it is, removed with the message.
const aes = require('../aes')

const BATCH = 1000

function decodeOne (piece) {
  try {
    const url = Buffer.from(aes.decrypt(piece), 'base64url').toString('utf8')
    return /^https?:\/\/\S+$/.test(url) ? url : null
  } catch (_) {
    return null
  }
}

module.exports = async client => {
  await client.query(`CREATE TABLE message_attachments (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (message_id, position)
  )`)
  let after = ''
  for (;;) {
    const rows = (await client.query(
      "SELECT id, attachment_b64 FROM messages WHERE id > $1 AND COALESCE(attachment_b64, '') <> '' ORDER BY id LIMIT $2",
      [after, BATCH])).rows
    if (rows.length === 0) break
    after = rows[rows.length - 1].id
    for (const row of rows) {
      const urls = row.attachment_b64.split('|').map(decodeOne).filter(Boolean)
      for (const [position, url] of urls.entries()) {
        await client.query('INSERT INTO message_attachments (message_id, position, url) VALUES ($1, $2, $3)', [row.id, position, aes.encrypt(url)])
      }
    }
  }
  await client.query('ALTER TABLE messages DROP COLUMN attachment_b64')
}
