// Posts of the streamer's X accounts (migrations/014_social_posts.sql).
const pool = require('../../clients/postgres')

// Stores posts not stored yet: [{ id, account, url, text, createdAt, replyTo, mediaUrls }].
// Resolves to the ones that were new.
async function savePosts (posts) {
  const added = []
  for (const p of posts) {
    const result = await pool.query(
      `INSERT INTO social_posts (id, account, url, text, created_at, reply_to, media_urls) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.account, p.url, p.text, p.createdAt, p.replyTo || null, p.mediaUrls || []])
    if (result.rowCount) added.push(p)
  }
  return added
}

// IDs of the account's stored posts.
async function knownIds (account) {
  const rows = await pool.query('SELECT id FROM social_posts WHERE account = $1', [account])
  return new Set(rows.rows.map(r => r.id))
}

// The account's posts made in the month of `month` (YYYY-MM, in Japan time), oldest first.
async function postsOfMonth (account, month) {
  const rows = await pool.query(
    `SELECT id, url, text, created_at, reply_to FROM social_posts
     WHERE account = $1 AND to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') = $2
     ORDER BY created_at`,
    [account, month])
  return rows.rows
}

module.exports = { savePosts, knownIds, postsOfMonth }
