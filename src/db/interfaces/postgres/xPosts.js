// Posts of the streamer's X accounts: the x_posts table (migrations/014_social_posts.sql, renamed in 015_x_knowledge.sql).
const pool = require('../../clients/postgres')

// Stores posts not stored yet: [{ id, account, url, text, createdAt, replyTo, mediaUrls }].
// Resolves to the ones that were new.
async function savePosts (posts) {
  const added = []
  for (const p of posts) {
    const result = await pool.query(
      `INSERT INTO x_posts (id, account, url, text, created_at, reply_to, media_urls) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.account, p.url, p.text, p.createdAt, p.replyTo || null, p.mediaUrls || []])
    if (result.rowCount) added.push(p)
  }
  return added
}

// IDs of the account's stored posts.
async function knownIds (account) {
  const rows = await pool.query('SELECT id FROM x_posts WHERE account = $1', [account])
  return new Set(rows.rows.map(r => r.id))
}

// The account's posts made in the month of `month` (YYYY-MM, in Japan time), oldest first. A
// range on created_at, so the index on the account and created_at is used.
async function postsOfMonth (account, month) {
  const rows = await pool.query(
    `SELECT id, url, text, created_at, reply_to FROM x_posts
     WHERE account = $1 AND created_at >= (($2 || '-01')::timestamp AT TIME ZONE 'Asia/Tokyo') AND created_at < ((($2 || '-01')::timestamp + interval '1 month') AT TIME ZONE 'Asia/Tokyo')
     ORDER BY created_at`,
    [account, month])
  return rows.rows
}

module.exports = { savePosts, knownIds, postsOfMonth }
