-- Drop the temporary summary_format_version tracking column and index from youtube_videos once
-- existing summaries have finished being rewritten to the fixed `- [時間] 行ったこと・結果` template,
-- and recreate v_youtube_videos without that column.
DROP VIEW IF EXISTS v_youtube_videos;

DROP INDEX IF EXISTS youtube_videos_legacy_summary_format;

ALTER TABLE youtube_videos
  DROP CONSTRAINT IF EXISTS youtube_videos_summary_check,
  DROP COLUMN IF EXISTS summary_format_version,
  ADD CONSTRAINT youtube_videos_summary_check
    CHECK ((summary IS NULL) = (summary_created_at IS NULL));

CREATE VIEW v_youtube_videos AS
SELECT
  v.video_id,
  'https://www.youtube.com/watch?v=' || v.video_id AS url,
  v.channel_id,
  c.title AS channel_title,
  c.handle AS channel_handle,
  (v.channel_id IS NULL) AS is_external,
  v.title,
  v.live_status,
  v.published_at,
  v.scheduled_start,
  v.actual_start,
  v.actual_end,
  v.duration,
  v.view_count,
  v.like_count,
  v.comment_count,
  (v.summary IS NOT NULL) AS has_summary,
  v.summary,
  v.summary_created_at,
  (v.embedding IS NOT NULL) AS has_embedding,
  v.embedding_model::text AS embedding_model,
  v.summary_batch,
  v.archive_attempts,
  v.stats_updated_at
FROM youtube_videos v
LEFT JOIN youtube_channels c ON c.channel_id = v.channel_id;

COMMENT ON VIEW v_youtube_videos IS 'YouTube動画・配信メタデータおよびAI要約一覧（チャンネル名・動画URL・要約/埋め込み有無付き、ベクトル列除外）';
COMMENT ON COLUMN v_youtube_videos.video_id IS 'YouTube動画ID';
COMMENT ON COLUMN v_youtube_videos.url IS 'YouTube動画ページのURL';
COMMENT ON COLUMN v_youtube_videos.channel_id IS '投稿元のYouTubeチャンネルID（外部チャンネル動画はNULL）';
COMMENT ON COLUMN v_youtube_videos.channel_title IS '投稿元のYouTubeチャンネル名';
COMMENT ON COLUMN v_youtube_videos.channel_handle IS '投稿元のYouTubeハンドル（@handle）';
COMMENT ON COLUMN v_youtube_videos.is_external IS 'フォロー対象外の外部チャンネル動画かどうか';
COMMENT ON COLUMN v_youtube_videos.title IS '動画・配信のタイトル';
COMMENT ON COLUMN v_youtube_videos.live_status IS '配信ステータス（none / upcoming / live）';
COMMENT ON COLUMN v_youtube_videos.published_at IS '動画公開日時';
COMMENT ON COLUMN v_youtube_videos.scheduled_start IS '配信開始予定日時';
COMMENT ON COLUMN v_youtube_videos.actual_start IS '実際の配信開始日時';
COMMENT ON COLUMN v_youtube_videos.actual_end IS '実際の配信終了日時';
COMMENT ON COLUMN v_youtube_videos.duration IS '動画の長さ（ISO 8601形式）';
COMMENT ON COLUMN v_youtube_videos.view_count IS '再生回数';
COMMENT ON COLUMN v_youtube_videos.like_count IS '高評価数';
COMMENT ON COLUMN v_youtube_videos.comment_count IS 'コメント数';
COMMENT ON COLUMN v_youtube_videos.has_summary IS 'AI要約が生成済みかどうか';
COMMENT ON COLUMN v_youtube_videos.summary IS 'AIが生成した動画・配信の要約テキスト';
COMMENT ON COLUMN v_youtube_videos.summary_created_at IS '要約を生成・更新した日時';
COMMENT ON COLUMN v_youtube_videos.has_embedding IS '検索用ベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_youtube_videos.embedding_model IS '埋め込み生成に使用したモデル名';
COMMENT ON COLUMN v_youtube_videos.summary_batch IS '処理中の要約バッチジョブ名';
COMMENT ON COLUMN v_youtube_videos.archive_attempts IS '配信終了後の自動アーカイブ要約試行回数';
COMMENT ON COLUMN v_youtube_videos.stats_updated_at IS '統計情報の最終取得日時';
