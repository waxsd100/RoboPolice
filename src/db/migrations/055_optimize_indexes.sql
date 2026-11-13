-- Optimizes PostgreSQL indexes and autovacuum settings across the consolidated schema based on
-- actual query patterns, Index-Only Scan coverage, partial-index selectivity, and HOT-update safety.

-- ============================================================================
-- 1. YouTube: drop dead view_count index (unlocks HOT updates on stats syncs),
--    make channel_published covering for video_id, and add tiny partial indexes
-- ============================================================================
DROP INDEX IF EXISTS youtube_videos_channel_views;

DROP INDEX IF EXISTS youtube_videos_channel_published;
CREATE INDEX youtube_videos_channel_published
  ON youtube_videos (channel_id, published_at DESC NULLS LAST)
  INCLUDE (video_id);

CREATE INDEX IF NOT EXISTS youtube_videos_live
  ON youtube_videos (channel_id, video_id)
  WHERE live_status IN ('live', 'upcoming');

CREATE INDEX IF NOT EXISTS youtube_videos_pending_archives
  ON youtube_videos (stream_ended_at)
  WHERE stream_ended_at IS NOT NULL AND summary IS NULL;

CREATE INDEX IF NOT EXISTS youtube_videos_orphan_external
  ON youtube_videos (video_id)
  WHERE channel_id IS NULL AND summary IS NULL AND summary_batch IS NULL;

-- ============================================================================
-- 2. Messages: partition unembedded partial index by guild_id and exclude
--    messages already queued in a running embedding_batch
-- ============================================================================
DROP INDEX IF EXISTS messages_unembedded;
CREATE INDEX messages_unembedded
  ON messages (guild_id, ts DESC)
  WHERE embedding_model IS NULL AND embedding_batch IS NULL;

-- ============================================================================
-- 3. Mention logs: match exact (guild_id, [user_id,] created_at DESC, id DESC)
--    filter & sort of getMentionLogs and drop unused standalone user_id index
-- ============================================================================
DROP INDEX IF EXISTS mention_logs_guild_created;
DROP INDEX IF EXISTS mention_logs_user_created;

CREATE INDEX mention_logs_guild_created
  ON mention_logs (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mention_logs_guild_user_created
  ON mention_logs (guild_id, user_id, created_at DESC, id DESC);

-- ============================================================================
-- 4. Guild emojis: include emoji_id order in guild_id index to avoid sorts
-- ============================================================================
DROP INDEX IF EXISTS guild_emojis_guild;
CREATE INDEX guild_emojis_guild
  ON guild_emojis (guild_id, emoji_id);

-- ============================================================================
-- 5. Knowledge: pre-sort character facts by name and add partial indexes for
--    unextracted sections and representative character images
-- ============================================================================
DROP INDEX IF EXISTS knowledge_facts_kind;
CREATE INDEX knowledge_facts_kind
  ON knowledge_facts (source, kind, name);

CREATE INDEX IF NOT EXISTS knowledge_sections_unextracted
  ON knowledge_sections (source, url, position)
  WHERE facts_hash IS DISTINCT FROM text_hash;

CREATE INDEX IF NOT EXISTS knowledge_sections_with_image
  ON knowledge_sections (source, url, position)
  WHERE image_url IS NOT NULL;

-- ============================================================================
-- 6. X posts & Twitch videos: add immutable PK as INCLUDE column for 0-heap
--    Index-Only Scans during syncs and overview counts without blocking HOT
-- ============================================================================
DROP INDEX IF EXISTS x_posts_account_created;
CREATE INDEX x_posts_account_created
  ON x_posts (account, created_at DESC)
  INCLUDE (id);

DROP INDEX IF EXISTS twitch_videos_user_published;
CREATE INDEX twitch_videos_user_published
  ON twitch_videos (user_id, published_at DESC NULLS LAST)
  INCLUDE (video_id);

-- ============================================================================
-- 7. Steam games: align partial indexes with getGames, getReviews, getWishlist
--    (steam_games_pkey already covers steam_id lookups and FK)
-- ============================================================================
DROP INDEX IF EXISTS steam_games_playtime;
CREATE INDEX steam_games_playtime
  ON steam_games (playtime_hours DESC NULLS LAST, app_id ASC)
  WHERE owned;

CREATE INDEX IF NOT EXISTS steam_games_reviews
  ON steam_games (review_position ASC, app_id ASC)
  WHERE review_content IS NOT NULL;

CREATE INDEX IF NOT EXISTS steam_games_wishlist
  ON steam_games (wishlisted_at DESC NULLS LAST, wishlist_priority ASC NULLS LAST, app_id ASC)
  WHERE wishlisted;

-- ============================================================================
-- 8. Autovacuum tuning on frequently synced tables to prevent dead-tuple bloat
-- ============================================================================
ALTER TABLE youtube_videos SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE twitch_videos SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE steam_games SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE guild_emojis SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE discord_channels SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
