-- Consolidate and normalize the schema to third normal form (41 -> 26 tables):
--   1. Merge youtube_summaries into youtube_videos and drop guild_youtube_summaries
--      (external videos have channel_id IS NULL and share summaries across all servers).
--   2. Unify embedding_batches, embedding_batch_messages, youtube_summary_batches and
--      youtube_summary_batch_videos into gemini_batches + FK columns on messages / youtube_videos.
--   3. Drop single-row discord_users and merge guild_ignored_channels + message_backfill +
--      discord_backfill into discord_channels.
--   4. Merge 1:1 guild_lore_style into guilds, drop duplicate guilds.reply_model / reply_thinking
--      (kept once in guild_ai_models), and drop unused legacy guild_disabled_events.
--   5. Normalize Steam titles solely into steam_apps (app_id FK) and merge steam_wishlist +
--      steam_reviews into steam_games (steam_id, app_id).
--   6. Inline 1:1 representative image_url into knowledge_sections (dropping knowledge_section_images)
--      and drop write-only unused x_post_media.

-- ============================================================================
-- 1. YouTube: youtube_summaries + guild_youtube_summaries -> youtube_videos
-- ============================================================================
ALTER TABLE youtube_videos
  ALTER COLUMN channel_id DROP NOT NULL,
  ALTER COLUMN title DROP NOT NULL,
  ADD COLUMN summary TEXT,
  ADD COLUMN summary_created_at TIMESTAMPTZ,
  ADD COLUMN summary_format_version SMALLINT,
  ADD CONSTRAINT youtube_videos_channel_title_check
    CHECK (channel_id IS NULL OR title IS NOT NULL),
  ADD CONSTRAINT youtube_videos_summary_check
    CHECK ((summary IS NULL) = (summary_format_version IS NULL)
       AND (summary IS NULL) = (summary_created_at IS NULL));

INSERT INTO youtube_videos (video_id, summary, summary_created_at, summary_format_version)
SELECT video_id, summary, created_at, format_version
FROM youtube_summaries
ON CONFLICT (video_id) DO UPDATE SET
  summary = EXCLUDED.summary,
  summary_created_at = EXCLUDED.summary_created_at,
  summary_format_version = EXCLUDED.summary_format_version;

CREATE INDEX youtube_videos_legacy_summary_format
  ON youtube_videos (summary_created_at DESC)
  WHERE summary IS NOT NULL AND summary_format_version < 2;

CREATE INDEX youtube_videos_other_summaries
  ON youtube_videos (summary_created_at DESC)
  WHERE channel_id IS NULL AND summary IS NOT NULL;

DROP TABLE guild_youtube_summaries, youtube_summaries;

COMMENT ON TABLE youtube_videos IS 'フォロー中チャンネルの動画・配信メタデータおよびYouTube動画のAI要約・ベクトル埋め込み（全サーバー共有）';
COMMENT ON COLUMN youtube_videos.channel_id IS '投稿元のYouTubeチャンネルID（外部チャンネルの要約済み動画はNULL）';
COMMENT ON COLUMN youtube_videos.title IS '動画・配信のタイトル（外部チャンネルの要約のみ保持する行はNULL）';
COMMENT ON COLUMN youtube_videos.summary IS 'Geminiが生成した動画・配信アーカイブの内容要約テキスト（未要約はNULL）';
COMMENT ON COLUMN youtube_videos.summary_created_at IS '要約テキストを生成・更新した日時';
COMMENT ON COLUMN youtube_videos.summary_format_version IS '要約フォーマットの世代番号（1=旧形式、2=固定テンプレート形式、未要約はNULL）';

-- ============================================================================
-- 2. Gemini Batch API jobs: 4 batch tables -> gemini_batches + FK columns
-- ============================================================================
CREATE TYPE batch_kind AS ENUM ('embedding', 'youtube_summary');
COMMENT ON TYPE batch_kind IS 'Gemini Batch APIジョブの用途区分（embedding: 過去メッセージ埋め込み / youtube_summary: YouTube動画要約）';

CREATE TABLE gemini_batches (
  name TEXT PRIMARY KEY,
  kind batch_kind NOT NULL,
  model TEXT NOT NULL,
  guild_id TEXT REFERENCES guilds (id) ON DELETE CASCADE,
  channel_id TEXT,
  requester_id TEXT,
  state TEXT,
  checked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gemini_batches_guild_check
    CHECK ((kind = 'youtube_summary') = (guild_id IS NOT NULL)),
  CONSTRAINT gemini_batches_notify_check
    CHECK (kind = 'youtube_summary' OR (channel_id IS NULL AND requester_id IS NULL))
);

CREATE INDEX gemini_batches_guild
  ON gemini_batches (guild_id)
  WHERE guild_id IS NOT NULL;

INSERT INTO gemini_batches (name, kind, model, state, checked_at, last_error, created_at)
SELECT name, 'embedding', model::text, state, checked_at, last_error, created_at
FROM embedding_batches;

INSERT INTO gemini_batches (name, kind, model, guild_id, channel_id, requester_id, state, checked_at, last_error, created_at)
SELECT name, 'youtube_summary', model, guild_id, channel_id, requester_id, state, checked_at, last_error, created_at
FROM youtube_summary_batches
ON CONFLICT (name) DO NOTHING;

-- Metadata-only nullable column addition on messages (no heap rewrite on 4.4 GB production volume).
ALTER TABLE messages
  ADD COLUMN embedding_batch TEXT REFERENCES gemini_batches (name) ON DELETE SET NULL;

UPDATE messages m
SET embedding_batch = b.batch_name
FROM embedding_batch_messages b
WHERE m.id = b.message_id;

CREATE INDEX messages_embedding_batch
  ON messages (embedding_batch)
  WHERE embedding_batch IS NOT NULL;

ALTER TABLE youtube_videos
  ADD COLUMN summary_batch TEXT REFERENCES gemini_batches (name) ON DELETE SET NULL,
  ADD COLUMN summary_batch_position SMALLINT,
  ADD CONSTRAINT youtube_videos_summary_batch_check
    CHECK (summary_batch IS NULL OR summary_batch_position IS NOT NULL);

INSERT INTO youtube_videos (video_id, summary_batch, summary_batch_position)
SELECT DISTINCT ON (sv.video_id) sv.video_id, sv.batch_name, sv.position
FROM youtube_summary_batch_videos sv
JOIN youtube_summary_batches sb ON sb.name = sv.batch_name
ORDER BY sv.video_id, sb.created_at DESC, sv.position ASC
ON CONFLICT (video_id) DO UPDATE SET
  summary_batch = EXCLUDED.summary_batch,
  summary_batch_position = EXCLUDED.summary_batch_position;

CREATE INDEX youtube_videos_summary_batch
  ON youtube_videos (summary_batch, summary_batch_position)
  WHERE summary_batch IS NOT NULL;

DROP TABLE
  embedding_batch_messages,
  embedding_batches,
  youtube_summary_batch_videos,
  youtube_summary_batches;

COMMENT ON TABLE gemini_batches IS '実行中のGemini Batch APIジョブ（過去メッセージ埋め込み・YouTube動画要約）の統合管理';
COMMENT ON COLUMN gemini_batches.name IS 'Gemini Batch APIのジョブ名（batches/...）';
COMMENT ON COLUMN gemini_batches.kind IS 'バッチジョブの用途区分（embedding / youtube_summary）';
COMMENT ON COLUMN gemini_batches.model IS 'バッチ処理に使用するGeminiモデル名';
COMMENT ON COLUMN gemini_batches.guild_id IS 'リクエスト元のDiscordサーバーID（YouTube要約バッチのみ、埋め込みバッチはNULL）';
COMMENT ON COLUMN gemini_batches.channel_id IS '完了通知を送信するDiscordチャンネルID（YouTube要約バッチ用）';
COMMENT ON COLUMN gemini_batches.requester_id IS 'コマンドを実行したDiscordユーザーID（YouTube要約バッチ用）';
COMMENT ON COLUMN gemini_batches.state IS '最終確認時点のGeminiバッチジョブ状態（BATCH_STATE_RUNNINGなど）';
COMMENT ON COLUMN gemini_batches.checked_at IS 'バッチジョブの状態を最終確認した日時';
COMMENT ON COLUMN gemini_batches.last_error IS '状態確認時に発生した直近のエラーメッセージ';
COMMENT ON COLUMN gemini_batches.created_at IS 'バッチジョブを作成した日時';

COMMENT ON COLUMN messages.embedding_batch IS '処理中の埋め込みバッチジョブ名（gemini_batches.name、バッチ対象外はNULL）';
COMMENT ON COLUMN youtube_videos.summary_batch IS '処理中の要約バッチジョブ名（gemini_batches.name、バッチ対象外はNULL）';
COMMENT ON COLUMN youtube_videos.summary_batch_position IS '要約バッチ結果レポート内での動画の並び順（0始まり）';

-- ============================================================================
-- 3. Discord: drop discord_users; merge guild_ignored_channels + message_backfill + discord_backfill -> discord_channels
-- ============================================================================
ALTER TABLE discord_posts
  DROP CONSTRAINT discord_posts_author_fkey;

DROP TABLE discord_users;

COMMENT ON COLUMN discord_posts.author_id IS '投稿者のDiscordユーザーID';

ALTER TABLE discord_channels
  ALTER COLUMN name DROP NOT NULL,
  ADD COLUMN ignored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN msg_before_id TEXT,
  ADD COLUMN msg_read_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN msg_done BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN msg_reached_start BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN msg_limit_start TIMESTAMPTZ,
  ADD COLUMN msg_limit_max INTEGER,
  ADD COLUMN msg_backfill_at TIMESTAMPTZ,
  ADD COLUMN post_before_id TEXT,
  ADD COLUMN post_done BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN post_backfill_at TIMESTAMPTZ;

INSERT INTO discord_channels (id, guild_id, ignored)
SELECT DISTINCT ON (channel_id) channel_id, guild_id, true
FROM guild_ignored_channels
ORDER BY channel_id, guild_id
ON CONFLICT (id) DO UPDATE SET
  ignored = true;

CREATE INDEX discord_channels_ignored
  ON discord_channels (guild_id, id)
  WHERE ignored;

INSERT INTO discord_channels (
  id, guild_id,
  msg_before_id, msg_read_count, msg_done, msg_reached_start, msg_limit_start, msg_limit_max, msg_backfill_at
)
SELECT
  channel_id, guild_id,
  before_id, read_count, done, reached_start, limit_start, limit_max, updated_at
FROM message_backfill
ON CONFLICT (id) DO UPDATE SET
  msg_before_id = EXCLUDED.msg_before_id,
  msg_read_count = EXCLUDED.msg_read_count,
  msg_done = EXCLUDED.msg_done,
  msg_reached_start = EXCLUDED.msg_reached_start,
  msg_limit_start = EXCLUDED.msg_limit_start,
  msg_limit_max = EXCLUDED.msg_limit_max,
  msg_backfill_at = EXCLUDED.msg_backfill_at;

INSERT INTO discord_channels (
  id, guild_id,
  post_before_id, post_done, post_backfill_at
)
SELECT
  channel_id, guild_id,
  before_id, done, updated_at
FROM discord_backfill
ON CONFLICT (id) DO UPDATE SET
  post_before_id = EXCLUDED.post_before_id,
  post_done = EXCLUDED.post_done,
  post_backfill_at = EXCLUDED.post_backfill_at;

DROP TABLE guild_ignored_channels, message_backfill, discord_backfill;

COMMENT ON TABLE discord_channels IS 'Discordチャンネルの基本情報・監査除外設定・過去ログ遡及取得（全体履歴・配信者発言）の進行状況';
COMMENT ON COLUMN discord_channels.name IS 'Discordチャンネル名（監査除外設定や履歴走査進捗のみ記録されている場合はNULL）';
COMMENT ON COLUMN discord_channels.ignored IS '監査ログの記録対象から除外されているチャンネルかどうか';
COMMENT ON COLUMN discord_channels.msg_before_id IS '過去ログ遡及取得（historyBackfill.js）で読み込んだ最古のメッセージID';
COMMENT ON COLUMN discord_channels.msg_read_count IS '過去ログ遡及取得でこれまでに読み込んだメッセージ件数';
COMMENT ON COLUMN discord_channels.msg_done IS '過去ログ遡及取得が現在の制限設定で完了しているかどうか';
COMMENT ON COLUMN discord_channels.msg_reached_start IS '過去ログ遡及取得がチャンネル先頭（最古）のメッセージまで到達したかどうか';
COMMENT ON COLUMN discord_channels.msg_limit_start IS '過去ログ遡及取得の完了時点における取得開始日時制限';
COMMENT ON COLUMN discord_channels.msg_limit_max IS '過去ログ遡及取得の完了時点における最大取得件数制限';
COMMENT ON COLUMN discord_channels.msg_backfill_at IS '過去ログ遡及取得の進行状況を最終更新した日時（未実行はNULL）';
COMMENT ON COLUMN discord_channels.post_before_id IS '配信者発言収集（discordKnowledge.js）で走査した最古のメッセージID';
COMMENT ON COLUMN discord_channels.post_done IS '配信者発言収集におけるチャンネル先頭までの走査が完了したかどうか';
COMMENT ON COLUMN discord_channels.post_backfill_at IS '配信者発言収集の走査進捗を最終更新した日時（未実行はNULL）';

-- ============================================================================
-- 4. Guilds: drop duplicate reply_model/reply_thinking, merge guild_lore_style,
--    and drop unused legacy guild_disabled_events
-- ============================================================================
INSERT INTO guild_ai_models (guild_id, task, model, thinking)
SELECT id, 'reply', reply_model, reply_thinking
FROM guilds
WHERE reply_model IS NOT NULL OR reply_thinking IS NOT NULL
ON CONFLICT (guild_id, task) DO UPDATE SET
  model = COALESCE(guild_ai_models.model, EXCLUDED.model),
  thinking = COALESCE(guild_ai_models.thinking, EXCLUDED.thinking);

ALTER TABLE guilds
  DROP COLUMN reply_model,
  DROP COLUMN reply_thinking,
  ADD COLUMN lore_style TEXT,
  ADD COLUMN lore_source_hash TEXT,
  ADD COLUMN lore_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT guilds_lore_style_check
    CHECK ((lore_style IS NULL) = (lore_source_hash IS NULL)
       AND (lore_style IS NULL) = (lore_updated_at IS NULL));

UPDATE guilds g
SET lore_style = s.style,
    lore_source_hash = s.source_hash,
    lore_updated_at = s.updated_at
FROM guild_lore_style s
WHERE g.id = s.guild_id;

DROP TABLE guild_lore_style;

DELETE FROM guild_event_logs e
USING guild_disabled_events d
WHERE e.guild_id = d.guild_id AND e.event = d.event;

DROP TABLE guild_disabled_events;

COMMENT ON COLUMN guilds.lore_style IS 'サーバー内の会話からAIが要約したコミュニティの話し方・雰囲気の特徴（未抽出はNULL）';
COMMENT ON COLUMN guilds.lore_source_hash IS '話し方・雰囲気要約の元となった知識群のハッシュ値（再生成判定用）';
COMMENT ON COLUMN guilds.lore_updated_at IS '話し方・雰囲気要約の最終更新日時';

-- ============================================================================
-- 5. Steam: keep app titles once in steam_apps; merge steam_wishlist + steam_reviews -> steam_games
-- ============================================================================
INSERT INTO steam_apps (app_id, name, name_en)
SELECT DISTINCT ON (src.app_id) src.app_id, src.name, src.name_en
FROM (
  SELECT app_id, name, name_en, 1 AS prio FROM steam_games WHERE name IS NOT NULL
  UNION ALL
  SELECT app_id, name, name_en, 2 AS prio FROM steam_wishlist WHERE name IS NOT NULL
  UNION ALL
  SELECT app_id, COALESCE(name, 'App ' || app_id::text) AS name, NULL::text AS name_en, 3 AS prio FROM steam_reviews
) src
ORDER BY src.app_id, src.prio ASC
ON CONFLICT (app_id) DO UPDATE SET
  name_en = COALESCE(steam_apps.name_en, EXCLUDED.name_en);

ALTER TABLE steam_games
  ADD COLUMN owned BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN wishlisted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN wishlist_priority INTEGER,
  ADD COLUMN wishlisted_at TIMESTAMPTZ,
  ADD COLUMN review_recommended BOOLEAN,
  ADD COLUMN review_hours REAL,
  ADD COLUMN review_posted TEXT,
  ADD COLUMN review_content TEXT,
  ADD COLUMN review_url TEXT,
  ADD COLUMN review_position INTEGER;

ALTER TABLE steam_games
  ALTER COLUMN owned SET DEFAULT false;

INSERT INTO steam_games (steam_id, app_id, name, owned, wishlisted, wishlist_priority, wishlisted_at)
SELECT steam_id, app_id, name, false, true, priority, added_at
FROM steam_wishlist
ON CONFLICT (steam_id, app_id) DO UPDATE SET
  wishlisted = true,
  wishlist_priority = EXCLUDED.wishlist_priority,
  wishlisted_at = EXCLUDED.wishlisted_at;

INSERT INTO steam_games (
  steam_id, app_id, name, owned,
  review_recommended, review_hours, review_posted, review_content, review_url, review_position
)
SELECT
  steam_id, app_id, COALESCE(name, 'App ' || app_id::text), false,
  recommended, hours_on_record, posted, content, url, position
FROM steam_reviews
ON CONFLICT (steam_id, app_id) DO UPDATE SET
  review_recommended = EXCLUDED.review_recommended,
  review_hours = EXCLUDED.review_hours,
  review_posted = EXCLUDED.review_posted,
  review_content = EXCLUDED.review_content,
  review_url = EXCLUDED.review_url,
  review_position = EXCLUDED.review_position;

ALTER TABLE steam_games
  DROP COLUMN name,
  DROP COLUMN name_en,
  ADD CONSTRAINT steam_games_app_fkey
    FOREIGN KEY (app_id) REFERENCES steam_apps (app_id),
  ADD CONSTRAINT steam_games_membership_check
    CHECK (owned OR wishlisted OR review_content IS NOT NULL),
  ADD CONSTRAINT steam_games_wishlist_check
    CHECK (wishlisted OR (wishlist_priority IS NULL AND wishlisted_at IS NULL)),
  ADD CONSTRAINT steam_games_review_check
    CHECK ((review_content IS NULL) = (review_recommended IS NULL)
       AND (review_content IS NULL) = (review_url IS NULL)
       AND (review_content IS NULL) = (review_position IS NULL));

CREATE INDEX steam_games_app ON steam_games (app_id);

DROP TABLE steam_reviews, steam_wishlist;

COMMENT ON TABLE steam_games IS 'フォロー中のSteamアカウントごとのゲーム状態（所持・プレイ時間・ウィッシュリスト・レビュー）';
COMMENT ON COLUMN steam_games.app_id IS 'SteamアプリケーションID（steam_apps.app_id）';
COMMENT ON COLUMN steam_games.owned IS '所持またはプレイ履歴が確認されているゲームかどうか';
COMMENT ON COLUMN steam_games.wishlisted IS 'ウィッシュリストに登録されているかどうか';
COMMENT ON COLUMN steam_games.wishlist_priority IS 'ウィッシュリスト内の優先順位';
COMMENT ON COLUMN steam_games.wishlisted_at IS 'ウィッシュリストに追加された日時';
COMMENT ON COLUMN steam_games.review_recommended IS 'レビューの評価（true: おすすめ / false: おすすめしない、未レビューはNULL）';
COMMENT ON COLUMN steam_games.review_hours IS 'レビュー投稿時点の総プレイ時間（時間単位）';
COMMENT ON COLUMN steam_games.review_posted IS 'レビュー投稿日の表示テキスト';
COMMENT ON COLUMN steam_games.review_content IS '投稿したレビュー本文テキスト（未レビューはNULL）';
COMMENT ON COLUMN steam_games.review_url IS 'レビューページのURL（未レビューはNULL）';
COMMENT ON COLUMN steam_games.review_position IS 'プロフィール上でのレビューの並び順（0始まり、未レビューはNULL）';

-- ============================================================================
-- 6. Knowledge & X posts: inline 1:1 representative image_url into knowledge_sections
--    and drop write-only unused x_post_media
-- ============================================================================
ALTER TABLE knowledge_sections
  ADD COLUMN image_url TEXT;

UPDATE knowledge_sections s
SET image_url = i.image_url
FROM (
  SELECT DISTINCT ON (source, url, position) source, url, position, image_url
  FROM knowledge_section_images
  ORDER BY source, url, position, image_position ASC
) i
WHERE s.source = i.source AND s.url = i.url AND s.position = i.position;

DROP TABLE knowledge_section_images, x_post_media;

COMMENT ON COLUMN knowledge_sections.image_url IS 'セクション内の代表画像URL（キャラクター画像など、画像なしはNULL）';
