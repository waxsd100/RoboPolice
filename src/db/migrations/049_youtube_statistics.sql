-- YouTube channel and video statistics plus actual stream timestamps, so questions about view
-- counts, subscriber counts and broadcast dates are answered from exact API data.

ALTER TABLE youtube_channels
  ADD COLUMN IF NOT EXISTS subscriber_count BIGINT,
  ADD COLUMN IF NOT EXISTS view_count BIGINT;

ALTER TABLE youtube_videos
  ADD COLUMN IF NOT EXISTS actual_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS view_count BIGINT,
  ADD COLUMN IF NOT EXISTS like_count BIGINT,
  ADD COLUMN IF NOT EXISTS comment_count BIGINT,
  ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS youtube_videos_channel_views
  ON youtube_videos (channel_id, view_count DESC NULLS LAST);

COMMENT ON COLUMN youtube_channels.subscriber_count IS 'YouTubeチャンネルの登録者数（非公開または未取得時はNULL）';
COMMENT ON COLUMN youtube_channels.view_count IS 'YouTubeチャンネルの総再生回数（未取得時はNULL）';

COMMENT ON COLUMN youtube_videos.actual_start IS '配信が実際に開始した日時（通常動画または未開始時はNULL）';
COMMENT ON COLUMN youtube_videos.actual_end IS '配信が実際に終了した日時（通常動画または配信終了前はNULL）';
COMMENT ON COLUMN youtube_videos.view_count IS '動画・配信の再生回数（未取得時はNULL）';
COMMENT ON COLUMN youtube_videos.like_count IS '動画・配信の高評価数（非公開または未取得時はNULL）';
COMMENT ON COLUMN youtube_videos.comment_count IS '動画・配信のコメント数（無効または未取得時はNULL）';
COMMENT ON COLUMN youtube_videos.stats_updated_at IS '再生回数などの統計情報をYouTube APIから最終取得した日時';
