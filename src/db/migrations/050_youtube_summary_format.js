// Tracks which prompt/template generation produced each stored YouTube summary (`format_version`:
// 1 = legacy free-form summaries, 2 = fixed `- [時間] 行ったこと・結果` template), and immediately
// strips preambles ("要約しました！"), outros ("以上です"), headings, bold markup and mixed timestamp
// styles from existing rows. The shard 0 worker then rewrites remaining `format_version = 1` prose
// in the background using the lightweight text model (videoSummary.js).
const format = require('pg-format')
const { cleanSummary } = require('../../bot/utils/textClean')

const BATCH = 500
const MAX_SUMMARY = 3000

module.exports = async client => {
  await client.query(`
    ALTER TABLE youtube_summaries
      ADD COLUMN IF NOT EXISTS format_version SMALLINT NOT NULL DEFAULT 1;
    ALTER TABLE youtube_summaries
      ALTER COLUMN format_version SET DEFAULT 2;
    CREATE INDEX IF NOT EXISTS youtube_summaries_legacy_format
      ON youtube_summaries (created_at DESC) WHERE format_version < 2;
    COMMENT ON COLUMN youtube_summaries.format_version IS '要約フォーマットの世代番号（1=旧形式、2=固定テンプレート形式）';
  `)

  let after = ''
  const toDelete = []
  for (;;) {
    const { rows } = await client.query(
      'SELECT video_id, summary FROM youtube_summaries WHERE video_id > $1 ORDER BY video_id LIMIT $2',
      [after, BATCH]
    )
    if (rows.length === 0) break
    after = rows[rows.length - 1].video_id
    const updates = []
    for (const r of rows) {
      const cleaned = cleanSummary(r.summary).slice(0, MAX_SUMMARY)
      if (!cleaned) toDelete.push(r.video_id)
      else if (cleaned !== r.summary) updates.push([r.video_id, cleaned])
    }
    if (updates.length) {
      await client.query(format(
        'UPDATE youtube_summaries s SET summary = v.summary FROM (VALUES %L) v(video_id, summary) WHERE s.video_id = v.video_id',
        updates
      ))
    }
  }
  if (toDelete.length) {
    await client.query('DELETE FROM youtube_summaries WHERE video_id = ANY($1)', [toDelete])
  }
}
