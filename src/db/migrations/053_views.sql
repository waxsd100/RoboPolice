-- Human-readable inspection views (all prefixed with v_) over the normalized 3NF schema.
-- Joins related master/detail tables, aggregates 1:N arrays, and replaces 512-dimensional
-- halfvec columns with boolean flags so GUI clients and psql queries stay concise and fast.

-- ============================================================================
-- 1. v_guilds: サーバー設定・利用統計一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_guilds AS
SELECT
  g.id,
  g.name,
  g.owner_id,
  g.member_count,
  g.joined_at,
  g.log_bots,
  g.youtube_live_events,
  g.streamer_persona,
  g.debug_footer,
  m.model::text AS reply_model,
  m.thinking::text AS reply_thinking,
  m.tier::text AS reply_tier,
  g.reply_length::text AS reply_length,
  g.embed_messages,
  g.embed_emojis,
  g.safety_filter,
  g.uncensored_r18,
  g.token_unlimited,
  g.token_limit_5h,
  g.token_limit_week,
  g.token_flex_at,
  (SELECT count(*)::int FROM guild_event_logs e WHERE e.guild_id = g.id) AS event_log_count,
  (SELECT count(*)::int FROM discord_channels c WHERE c.guild_id = g.id AND c.ignored) AS ignored_channel_count,
  (SELECT count(*)::int FROM guild_emojis em WHERE em.guild_id = g.id) AS emoji_count,
  (g.assistant_rules IS NOT NULL) AS has_assistant_rules,
  (g.lore_style IS NOT NULL) AS has_lore_style,
  g.details_updated_at
FROM guilds g
LEFT JOIN guild_ai_models m ON m.guild_id = g.id AND m.task = 'reply';

COMMENT ON VIEW v_guilds IS 'Discordサーバー一覧と主要な応答・監査・トークン制限・登録件数のサマリー';
COMMENT ON COLUMN v_guilds.id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_guilds.name IS 'Discordサーバー名';
COMMENT ON COLUMN v_guilds.owner_id IS 'サーバーオーナーのDiscordユーザーID';
COMMENT ON COLUMN v_guilds.member_count IS 'サーバーのメンバー数';
COMMENT ON COLUMN v_guilds.joined_at IS 'Botがサーバーに参加した日時';
COMMENT ON COLUMN v_guilds.log_bots IS 'Botアカウントのアクションも監査ログに記録するかどうか';
COMMENT ON COLUMN v_guilds.youtube_live_events IS 'YouTube配信予定のDiscordイベント自動連携が有効かどうか';
COMMENT ON COLUMN v_guilds.streamer_persona IS '配信者ペルソナ応答モードが有効かどうか';
COMMENT ON COLUMN v_guilds.debug_footer IS '応答末尾へのデバッグ情報フッター表示が有効かどうか';
COMMENT ON COLUMN v_guilds.reply_model IS 'メンション応答（replyタスク）のAIモデル設定';
COMMENT ON COLUMN v_guilds.reply_thinking IS 'メンション応答（replyタスク）の思考レベル設定';
COMMENT ON COLUMN v_guilds.reply_tier IS 'メンション応答（replyタスク）のサービスティア設定';
COMMENT ON COLUMN v_guilds.reply_length IS 'メンション応答の文字数目安設定';
COMMENT ON COLUMN v_guilds.embed_messages IS 'メッセージ埋め込み検索のサーバー個別設定';
COMMENT ON COLUMN v_guilds.embed_emojis IS '絵文字埋め込み検索のサーバー個別設定';
COMMENT ON COLUMN v_guilds.safety_filter IS 'Geminiセーフティフィルターのサーバー個別設定';
COMMENT ON COLUMN v_guilds.uncensored_r18 IS '無検閲モデルフォールバックのサーバー個別設定';
COMMENT ON COLUMN v_guilds.token_unlimited IS 'トークン利用制限の無制限フラグ';
COMMENT ON COLUMN v_guilds.token_limit_5h IS '5時間あたりのトークン上限設定';
COMMENT ON COLUMN v_guilds.token_limit_week IS '1週間あたりのトークン上限設定';
COMMENT ON COLUMN v_guilds.token_flex_at IS 'Flex推論へ切り替えるトークン消費率しきい値（%）';
COMMENT ON COLUMN v_guilds.event_log_count IS '有効化されている監査ログイベント種別の件数';
COMMENT ON COLUMN v_guilds.ignored_channel_count IS '監査ログ対象外に設定されているチャンネル数';
COMMENT ON COLUMN v_guilds.emoji_count IS '同期されているサーバーカスタム絵文字の件数';
COMMENT ON COLUMN v_guilds.has_assistant_rules IS 'サーバー独自の応答ルールが設定されているかどうか';
COMMENT ON COLUMN v_guilds.has_lore_style IS 'サーバーの話し方・雰囲気要約が生成済みかどうか';
COMMENT ON COLUMN v_guilds.details_updated_at IS 'サーバー基本情報の最終更新日時';

-- ============================================================================
-- 2. v_guild_ai_models: サーバー別 AI タスクモデル設定一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_guild_ai_models AS
SELECT
  m.guild_id,
  g.name AS guild_name,
  m.task::text AS task,
  m.model::text AS model,
  m.thinking::text AS thinking,
  m.tier::text AS tier
FROM guild_ai_models m
JOIN guilds g ON g.id = m.guild_id;

COMMENT ON VIEW v_guild_ai_models IS 'サーバーおよびAIタスクごとのモデル・思考レベル・推論ティア設定一覧（サーバー名付き）';
COMMENT ON COLUMN v_guild_ai_models.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_guild_ai_models.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_guild_ai_models.task IS 'AIタスク種別（reply / rules / blurb / light / extract / summary）';
COMMENT ON COLUMN v_guild_ai_models.model IS '使用モデル設定（NULLはデフォルト）';
COMMENT ON COLUMN v_guild_ai_models.thinking IS '思考レベル設定（NULLはデフォルト）';
COMMENT ON COLUMN v_guild_ai_models.tier IS '推論ティア設定（standard / flex、NULLはデフォルト）';

-- ============================================================================
-- 3. v_discord_channels: Discord チャンネル設定・履歴遡及進捗一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_discord_channels AS
SELECT
  c.id,
  c.guild_id,
  g.name AS guild_name,
  c.name,
  c.ignored,
  c.msg_done,
  c.msg_reached_start,
  c.msg_read_count,
  c.msg_before_id,
  c.msg_limit_start,
  c.msg_limit_max,
  c.msg_backfill_at,
  c.post_done,
  c.post_before_id,
  c.post_backfill_at
FROM discord_channels c
JOIN guilds g ON g.id = c.guild_id;

COMMENT ON VIEW v_discord_channels IS 'Discordチャンネルごとの監査除外設定・過去ログ遡及取得および配信者発言収集の進行状況一覧';
COMMENT ON COLUMN v_discord_channels.id IS 'DiscordチャンネルID';
COMMENT ON COLUMN v_discord_channels.guild_id IS '所属するDiscordサーバーID';
COMMENT ON COLUMN v_discord_channels.guild_name IS '所属するDiscordサーバー名';
COMMENT ON COLUMN v_discord_channels.name IS 'Discordチャンネル名';
COMMENT ON COLUMN v_discord_channels.ignored IS '監査ログ記録の対象外チャンネルかどうか';
COMMENT ON COLUMN v_discord_channels.msg_done IS '全体過去ログ遡及取得が完了しているかどうか';
COMMENT ON COLUMN v_discord_channels.msg_reached_start IS '全体過去ログ遡及取得がチャンネル先頭まで到達したかどうか';
COMMENT ON COLUMN v_discord_channels.msg_read_count IS '全体過去ログ遡及取得で読み込んだ累計メッセージ数';
COMMENT ON COLUMN v_discord_channels.msg_before_id IS '全体過去ログ遡及取得で読み込んだ最古のメッセージID';
COMMENT ON COLUMN v_discord_channels.msg_limit_start IS '全体過去ログ遡及取得の開始日時制限';
COMMENT ON COLUMN v_discord_channels.msg_limit_max IS '全体過去ログ遡及取得の最大件数制限';
COMMENT ON COLUMN v_discord_channels.msg_backfill_at IS '全体過去ログ遡及取得の最終更新日時';
COMMENT ON COLUMN v_discord_channels.post_done IS '配信者発言収集がチャンネル先頭まで完了したかどうか';
COMMENT ON COLUMN v_discord_channels.post_before_id IS '配信者発言収集で走査した最古のメッセージID';
COMMENT ON COLUMN v_discord_channels.post_backfill_at IS '配信者発言収集の最終更新日時';

-- ============================================================================
-- 4. v_messages: 保存メッセージ一覧（巨大ベクトル除外・添付画像配列付き）
-- ============================================================================
CREATE OR REPLACE VIEW v_messages AS
SELECT
  m.id,
  m.guild_id,
  g.name AS guild_name,
  m.channel_id,
  c.name AS channel_name,
  m.author_id,
  m.content,
  COALESCE(
    (SELECT array_agg(a.url ORDER BY a.position) FROM message_attachments a WHERE a.message_id = m.id),
    '{}'
  ) AS attachment_urls,
  m.ts,
  (m.embedding IS NOT NULL) AS has_embedding,
  m.embedding_model::text AS embedding_model,
  m.embedding_batch
FROM messages m
LEFT JOIN guilds g ON g.id = m.guild_id
LEFT JOIN discord_channels c ON c.id = m.channel_id;

COMMENT ON VIEW v_messages IS '保存されたDiscordメッセージ一覧（サーバー名・チャンネル名・添付画像配列付き、ベクトル列除外）';
COMMENT ON COLUMN v_messages.id IS 'DiscordメッセージID';
COMMENT ON COLUMN v_messages.guild_id IS '投稿先DiscordサーバーID（DM等はNULL）';
COMMENT ON COLUMN v_messages.guild_name IS '投稿先Discordサーバー名';
COMMENT ON COLUMN v_messages.channel_id IS '投稿先DiscordチャンネルID';
COMMENT ON COLUMN v_messages.channel_name IS '投稿先Discordチャンネル名';
COMMENT ON COLUMN v_messages.author_id IS '投稿者のDiscordユーザーID';
COMMENT ON COLUMN v_messages.content IS '保存されているメッセージ本文';
COMMENT ON COLUMN v_messages.attachment_urls IS '添付画像URLの配列（並び順通り）';
COMMENT ON COLUMN v_messages.ts IS 'メッセージの投稿日時';
COMMENT ON COLUMN v_messages.has_embedding IS 'ベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_messages.embedding_model IS '埋め込み処理に使用したモデル名';
COMMENT ON COLUMN v_messages.embedding_batch IS '処理中の埋め込みバッチジョブ名';

-- ============================================================================
-- 5. v_discord_posts: 配信者 Discord 発言一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_discord_posts AS
SELECT
  p.id,
  c.guild_id,
  g.name AS guild_name,
  p.channel_id,
  c.name AS channel_name,
  p.author_id,
  p.content,
  'https://discord.com/channels/' || c.guild_id || '/' || p.channel_id || '/' || p.id AS url,
  p.created_at
FROM discord_posts p
JOIN discord_channels c ON c.id = p.channel_id
LEFT JOIN guilds g ON g.id = c.guild_id;

COMMENT ON VIEW v_discord_posts IS '知識抽出対象アカウントのDiscord発言一覧（サーバー名・チャンネル名・メッセージURL付き）';
COMMENT ON COLUMN v_discord_posts.id IS 'DiscordメッセージID';
COMMENT ON COLUMN v_discord_posts.guild_id IS '投稿先DiscordサーバーID';
COMMENT ON COLUMN v_discord_posts.guild_name IS '投稿先Discordサーバー名';
COMMENT ON COLUMN v_discord_posts.channel_id IS '投稿先DiscordチャンネルID';
COMMENT ON COLUMN v_discord_posts.channel_name IS '投稿先Discordチャンネル名';
COMMENT ON COLUMN v_discord_posts.author_id IS '投稿者のDiscordユーザーID';
COMMENT ON COLUMN v_discord_posts.content IS '発言テキスト本文';
COMMENT ON COLUMN v_discord_posts.url IS 'Discordメッセージへの直リンクURL';
COMMENT ON COLUMN v_discord_posts.created_at IS '発言の投稿日時';

-- ============================================================================
-- 6. v_mention_logs: メンション応答ログ一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_mention_logs AS
SELECT
  l.id,
  l.guild_id,
  g.name AS guild_name,
  l.channel_id,
  c.name AS channel_name,
  l.message_id,
  l.reply_message_id,
  l.user_id,
  l.user_name,
  l.kind,
  l.model,
  l.request,
  l.referenced_text,
  l.response,
  l.prompt_tokens,
  l.cached_tokens,
  l.output_tokens,
  l.thinking_tokens,
  (l.prompt_tokens + l.output_tokens + l.thinking_tokens) AS total_tokens,
  l.gemini_calls,
  l.created_at
FROM mention_logs l
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN discord_channels c ON c.id = l.channel_id;

COMMENT ON VIEW v_mention_logs IS 'Botへのメンション質問と応答・トークン消費量の履歴一覧（サーバー名・チャンネル名・総トークン数付き）';
COMMENT ON COLUMN v_mention_logs.id IS 'メンションログ連番ID';
COMMENT ON COLUMN v_mention_logs.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_mention_logs.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_mention_logs.channel_id IS 'DiscordチャンネルID';
COMMENT ON COLUMN v_mention_logs.channel_name IS 'Discordチャンネル名';
COMMENT ON COLUMN v_mention_logs.message_id IS 'ユーザーの質問メッセージID';
COMMENT ON COLUMN v_mention_logs.reply_message_id IS 'Botの返信メッセージID';
COMMENT ON COLUMN v_mention_logs.user_id IS '質問者のDiscordユーザーID';
COMMENT ON COLUMN v_mention_logs.user_name IS '質問時点でのユーザー表示名';
COMMENT ON COLUMN v_mention_logs.kind IS '応答種別（chat / event / forum / edit等）';
COMMENT ON COLUMN v_mention_logs.model IS '応答生成に使用したAIモデル名';
COMMENT ON COLUMN v_mention_logs.request IS 'ユーザーの質問テキスト';
COMMENT ON COLUMN v_mention_logs.referenced_text IS '返信先として参照された元メッセージ本文';
COMMENT ON COLUMN v_mention_logs.response IS 'Botが送信した応答テキスト';
COMMENT ON COLUMN v_mention_logs.prompt_tokens IS '入力プロンプトトークン数';
COMMENT ON COLUMN v_mention_logs.cached_tokens IS 'キャッシュヒットした入力トークン数';
COMMENT ON COLUMN v_mention_logs.output_tokens IS '出力トークン数';
COMMENT ON COLUMN v_mention_logs.thinking_tokens IS '思考トークン数';
COMMENT ON COLUMN v_mention_logs.total_tokens IS '総消費トークン数（入力＋出力＋思考）';
COMMENT ON COLUMN v_mention_logs.gemini_calls IS 'Gemini API呼び出し回数';
COMMENT ON COLUMN v_mention_logs.created_at IS '応答ログ記録日時';

-- ============================================================================
-- 7. v_guild_emojis: サーバーカスタム絵文字一覧（巨大ベクトル除外）
-- ============================================================================
CREATE OR REPLACE VIEW v_guild_emojis AS
SELECT
  e.emoji_id,
  e.guild_id,
  g.name AS guild_name,
  e.name,
  e.animated,
  e.description,
  e.described_name,
  (e.embedding IS NOT NULL) AS has_embedding,
  e.embedding_model::text AS embedding_model,
  e.updated_at
FROM guild_emojis e
LEFT JOIN guilds g ON g.id = e.guild_id;

COMMENT ON VIEW v_guild_emojis IS 'サーバーのカスタム絵文字とAIによる意味説明・埋め込み状況一覧（ベクトル列除外）';
COMMENT ON COLUMN v_guild_emojis.emoji_id IS 'Discordカスタム絵文字ID';
COMMENT ON COLUMN v_guild_emojis.guild_id IS '所属するDiscordサーバーID';
COMMENT ON COLUMN v_guild_emojis.guild_name IS '所属するDiscordサーバー名';
COMMENT ON COLUMN v_guild_emojis.name IS '現在の絵文字名';
COMMENT ON COLUMN v_guild_emojis.animated IS 'アニメーション絵文字かどうか';
COMMENT ON COLUMN v_guild_emojis.description IS 'AIが生成した絵文字の見た目・用途の説明文';
COMMENT ON COLUMN v_guild_emojis.described_name IS '説明文生成時点での絵文字名';
COMMENT ON COLUMN v_guild_emojis.has_embedding IS '意味検索用のベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_guild_emojis.embedding_model IS '埋め込み生成に使用したモデル名';
COMMENT ON COLUMN v_guild_emojis.updated_at IS '絵文字情報の最終更新日時';

-- ============================================================================
-- 8. v_guild_lore: サーバー内知識（内輪ネタ・用語・出来事）一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_guild_lore AS
SELECT
  f.id,
  f.guild_id,
  g.name AS guild_name,
  f.channel_id,
  c.name AS channel_name,
  f.week,
  f.kind,
  f.name,
  f.content,
  (f.embedding IS NOT NULL) AS has_embedding,
  f.embedding_model::text AS embedding_model,
  ch.extracted_at
FROM guild_lore_facts f
JOIN guild_lore_chunks ch ON ch.guild_id = f.guild_id AND ch.channel_id = f.channel_id AND ch.week = f.week
LEFT JOIN guilds g ON g.id = f.guild_id
LEFT JOIN discord_channels c ON c.id = f.channel_id;

COMMENT ON VIEW v_guild_lore IS 'サーバー内の会話から抽出された内輪ネタ・用語・出来事一覧（サーバー名・チャンネル名付き、ベクトル列除外）';
COMMENT ON COLUMN v_guild_lore.id IS 'サーバー内知識ファクトID';
COMMENT ON COLUMN v_guild_lore.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_guild_lore.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_guild_lore.channel_id IS '抽出元DiscordチャンネルID';
COMMENT ON COLUMN v_guild_lore.channel_name IS '抽出元Discordチャンネル名';
COMMENT ON COLUMN v_guild_lore.week IS '抽出対象の週開始日（月曜日）';
COMMENT ON COLUMN v_guild_lore.kind IS '知識の分類（joke / term / event等）';
COMMENT ON COLUMN v_guild_lore.name IS '項目名・見出し語';
COMMENT ON COLUMN v_guild_lore.content IS '知識の内容説明テキスト';
COMMENT ON COLUMN v_guild_lore.has_embedding IS 'ベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_guild_lore.embedding_model IS '埋め込み生成に使用したモデル名';
COMMENT ON COLUMN v_guild_lore.extracted_at IS '週次チャンクから知識を抽出した日時';

-- ============================================================================
-- 9. v_knowledge_sections: 配信者知識セクション一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_knowledge_sections AS
SELECT
  s.source,
  s.url,
  p.title AS page_title,
  s.position,
  s.heading,
  s.text,
  s.image_url,
  (s.facts_hash IS NOT NULL AND s.facts_hash = s.text_hash) AS facts_extracted,
  (SELECT count(*)::int FROM knowledge_facts f WHERE f.source = s.source AND f.url = s.url AND f.position = s.position) AS fact_count,
  (s.embedding IS NOT NULL) AS has_embedding,
  s.embedding_model::text AS embedding_model,
  p.fetched_at
FROM knowledge_sections s
JOIN knowledge_pages p ON p.source = s.source AND p.url = s.url;

COMMENT ON VIEW v_knowledge_sections IS 'Wiki・X・Discord・Webから取得した知識セクション一覧（ページタイトル・ファクト件数付き、ベクトル列除外）';
COMMENT ON COLUMN v_knowledge_sections.source IS '知識ソース種別（wiki / x / discord / web）';
COMMENT ON COLUMN v_knowledge_sections.url IS '知識ページのURLまたは識別子';
COMMENT ON COLUMN v_knowledge_sections.page_title IS '知識ページのタイトル';
COMMENT ON COLUMN v_knowledge_sections.position IS 'ページ内のセクション順序（0始まり）';
COMMENT ON COLUMN v_knowledge_sections.heading IS 'セクションの見出し';
COMMENT ON COLUMN v_knowledge_sections.text IS 'セクションの本文テキスト';
COMMENT ON COLUMN v_knowledge_sections.image_url IS 'セクションの代表画像URL';
COMMENT ON COLUMN v_knowledge_sections.facts_extracted IS '最新本文に対するファクト抽出が完了しているかどうか';
COMMENT ON COLUMN v_knowledge_sections.fact_count IS 'このセクションから抽出されたファクト件数';
COMMENT ON COLUMN v_knowledge_sections.has_embedding IS 'セクションのベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_knowledge_sections.embedding_model IS '埋め込み生成に使用したモデル名';
COMMENT ON COLUMN v_knowledge_sections.fetched_at IS 'ページの最終取得日時';

-- ============================================================================
-- 10. v_knowledge_facts: 配信者知識ファクト一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_knowledge_facts AS
SELECT
  f.id,
  f.source,
  f.kind,
  f.name,
  COALESCE(
    (SELECT array_agg(a.alias ORDER BY a.alias_position) FROM knowledge_fact_aliases a WHERE a.fact_id = f.id),
    '{}'
  ) AS aliases,
  f.content,
  f.url,
  p.title AS page_title,
  f.position,
  s.heading,
  (f.embedding IS NOT NULL) AS has_embedding,
  f.embedding_model::text AS embedding_model
FROM knowledge_facts f
JOIN knowledge_sections s ON s.source = f.source AND s.url = f.url AND s.position = f.position
JOIN knowledge_pages p ON p.source = f.source AND p.url = f.url;

COMMENT ON VIEW v_knowledge_facts IS '知識セクションから抽出された構造化ファクト一覧（ページタイトル・見出し・別名配列付き、ベクトル列除外）';
COMMENT ON COLUMN v_knowledge_facts.id IS '知識ファクトID';
COMMENT ON COLUMN v_knowledge_facts.source IS '知識ソース種別（wiki / x / discord / web）';
COMMENT ON COLUMN v_knowledge_facts.kind IS 'ファクト分類（character / term / episode等）';
COMMENT ON COLUMN v_knowledge_facts.name IS 'ファクトの名称・見出し語';
COMMENT ON COLUMN v_knowledge_facts.aliases IS '別名・表記ゆれの配列';
COMMENT ON COLUMN v_knowledge_facts.content IS 'ファクトの説明内容';
COMMENT ON COLUMN v_knowledge_facts.url IS '抽出元ページのURL';
COMMENT ON COLUMN v_knowledge_facts.page_title IS '抽出元ページのタイトル';
COMMENT ON COLUMN v_knowledge_facts.position IS '抽出元セクションの並び順';
COMMENT ON COLUMN v_knowledge_facts.heading IS '抽出元セクションの見出し';
COMMENT ON COLUMN v_knowledge_facts.has_embedding IS 'ベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_knowledge_facts.embedding_model IS '埋め込み生成に使用したモデル名';

-- ============================================================================
-- 11. v_youtube_videos: YouTube 動画・配信・要約一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_youtube_videos AS
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
  v.summary_format_version,
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
COMMENT ON COLUMN v_youtube_videos.summary_format_version IS '要約フォーマット世代番号（1=旧形式、2=固定テンプレート形式）';
COMMENT ON COLUMN v_youtube_videos.summary_created_at IS '要約を生成・更新した日時';
COMMENT ON COLUMN v_youtube_videos.has_embedding IS '検索用ベクトル埋め込みが生成済みかどうか';
COMMENT ON COLUMN v_youtube_videos.embedding_model IS '埋め込み生成に使用したモデル名';
COMMENT ON COLUMN v_youtube_videos.summary_batch IS '処理中の要約バッチジョブ名';
COMMENT ON COLUMN v_youtube_videos.archive_attempts IS '配信終了後の自動アーカイブ要約試行回数';
COMMENT ON COLUMN v_youtube_videos.stats_updated_at IS '統計情報の最終取得日時';

-- ============================================================================
-- 12. v_youtube_live_events: YouTube × Discord イベント連携一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_youtube_live_events AS
SELECT
  e.guild_id,
  g.name AS guild_name,
  e.video_id,
  v.title AS video_title,
  v.channel_id,
  c.title AS channel_title,
  e.event_id,
  e.kind,
  e.status,
  e.scheduled_start,
  e.scheduled_end
FROM youtube_live_events e
JOIN youtube_videos v ON v.video_id = e.video_id
LEFT JOIN guilds g ON g.id = e.guild_id
LEFT JOIN youtube_channels c ON c.channel_id = v.channel_id;

COMMENT ON VIEW v_youtube_live_events IS 'YouTube配信・プレミア公開に紐づくDiscordスケジュールイベント一覧（サーバー名・チャンネル名・動画タイトル付き）';
COMMENT ON COLUMN v_youtube_live_events.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_youtube_live_events.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_youtube_live_events.video_id IS 'YouTube動画ID';
COMMENT ON COLUMN v_youtube_live_events.video_title IS '動画・配信のタイトル';
COMMENT ON COLUMN v_youtube_live_events.channel_id IS 'YouTubeチャンネルID';
COMMENT ON COLUMN v_youtube_live_events.channel_title IS 'YouTubeチャンネル名';
COMMENT ON COLUMN v_youtube_live_events.event_id IS '作成されたDiscordスケジュールイベントID';
COMMENT ON COLUMN v_youtube_live_events.kind IS 'イベント種別（stream / upload）';
COMMENT ON COLUMN v_youtube_live_events.status IS 'イベント状態（scheduled / active / completed / canceled）';
COMMENT ON COLUMN v_youtube_live_events.scheduled_start IS 'イベント開始予定日時';
COMMENT ON COLUMN v_youtube_live_events.scheduled_end IS 'イベント終了予定日時';

-- ============================================================================
-- 13. v_twitch_videos: Twitch 配信アーカイブ一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_twitch_videos AS
SELECT
  v.video_id,
  v.user_id,
  c.login,
  c.display_name,
  v.title,
  v.description,
  v.url,
  v.published_at,
  v.duration,
  v.view_count
FROM twitch_videos v
JOIN twitch_channels c ON c.user_id = v.user_id;

COMMENT ON VIEW v_twitch_videos IS 'Twitch配信アーカイブ一覧（チャンネルログイン名・表示名付き）';
COMMENT ON COLUMN v_twitch_videos.video_id IS 'TwitchビデオID';
COMMENT ON COLUMN v_twitch_videos.user_id IS 'TwitchユーザーID';
COMMENT ON COLUMN v_twitch_videos.login IS 'Twitchログイン名';
COMMENT ON COLUMN v_twitch_videos.display_name IS 'Twitchチャンネル表示名';
COMMENT ON COLUMN v_twitch_videos.title IS '配信アーカイブのタイトル';
COMMENT ON COLUMN v_twitch_videos.description IS '配信アーカイブの説明文';
COMMENT ON COLUMN v_twitch_videos.url IS 'TwitchアーカイブページのURL';
COMMENT ON COLUMN v_twitch_videos.published_at IS '配信公開日時';
COMMENT ON COLUMN v_twitch_videos.duration IS '配信アーカイブの長さ';
COMMENT ON COLUMN v_twitch_videos.view_count IS '視聴回数';

-- ============================================================================
-- 14. v_steam_games: Steam 所持・ウィッシュリスト・レビュー統合一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_steam_games AS
SELECT
  g.steam_id,
  p.account_ref,
  p.persona_name,
  g.app_id,
  a.name AS app_name,
  a.name_en AS app_name_en,
  g.owned,
  g.playtime_hours,
  g.recent_hours,
  g.first_played_at,
  g.last_played_at,
  g.wishlisted,
  g.wishlist_priority,
  g.wishlisted_at,
  (g.review_content IS NOT NULL) AS has_review,
  g.review_recommended,
  g.review_hours,
  g.review_posted,
  g.review_content,
  g.review_url,
  g.review_position
FROM steam_games g
JOIN steam_profiles p ON p.steam_id = g.steam_id
JOIN steam_apps a ON a.app_id = g.app_id;

COMMENT ON VIEW v_steam_games IS 'フォロー中のSteamアカウントの所持ゲーム・プレイ時間・ウィッシュリスト・レビュー統合一覧（ゲーム名付き）';
COMMENT ON COLUMN v_steam_games.steam_id IS '64bit Steam ID';
COMMENT ON COLUMN v_steam_games.account_ref IS '設定されたSteamアカウント識別子';
COMMENT ON COLUMN v_steam_games.persona_name IS 'Steamプロフィール表示名';
COMMENT ON COLUMN v_steam_games.app_id IS 'SteamアプリケーションID';
COMMENT ON COLUMN v_steam_games.app_name IS 'ゲームの日本語タイトル（またはデフォルト名）';
COMMENT ON COLUMN v_steam_games.app_name_en IS 'ゲームの英語タイトル';
COMMENT ON COLUMN v_steam_games.owned IS '所持またはプレイ履歴があるゲームかどうか';
COMMENT ON COLUMN v_steam_games.playtime_hours IS '累計プレイ時間（時間単位）';
COMMENT ON COLUMN v_steam_games.recent_hours IS '直近2週間のプレイ時間（時間単位）';
COMMENT ON COLUMN v_steam_games.first_played_at IS 'Botが最初にプレイを確認した日時';
COMMENT ON COLUMN v_steam_games.last_played_at IS 'Botが最後にプレイ増加を確認した日時';
COMMENT ON COLUMN v_steam_games.wishlisted IS 'ウィッシュリストに登録されているかどうか';
COMMENT ON COLUMN v_steam_games.wishlist_priority IS 'ウィッシュリスト内の優先順位';
COMMENT ON COLUMN v_steam_games.wishlisted_at IS 'ウィッシュリストへの追加日時';
COMMENT ON COLUMN v_steam_games.has_review IS 'レビューが投稿されているかどうか';
COMMENT ON COLUMN v_steam_games.review_recommended IS 'レビュー評価（true: おすすめ / false: おすすめしない）';
COMMENT ON COLUMN v_steam_games.review_hours IS 'レビュー投稿時点のプレイ時間（時間単位）';
COMMENT ON COLUMN v_steam_games.review_posted IS 'レビュー投稿日の表示テキスト';
COMMENT ON COLUMN v_steam_games.review_content IS 'レビュー本文テキスト';
COMMENT ON COLUMN v_steam_games.review_url IS 'SteamレビューページのURL';
COMMENT ON COLUMN v_steam_games.review_position IS 'プロフィール上のレビュー並び順（0始まり）';

-- ============================================================================
-- 15. v_gemini_batches: 実行中 Gemini バッチジョブ一覧
-- ============================================================================
CREATE OR REPLACE VIEW v_gemini_batches AS
SELECT
  b.name,
  b.kind::text AS kind,
  b.model,
  b.guild_id,
  g.name AS guild_name,
  b.channel_id,
  b.requester_id,
  CASE
    WHEN b.kind = 'embedding' THEN (SELECT count(*)::int FROM messages m WHERE m.embedding_batch = b.name)
    ELSE (SELECT count(*)::int FROM youtube_videos v WHERE v.summary_batch = b.name)
  END AS item_count,
  b.state,
  b.checked_at,
  b.last_error,
  b.created_at
FROM gemini_batches b
LEFT JOIN guilds g ON g.id = b.guild_id;

COMMENT ON VIEW v_gemini_batches IS '実行中のGemini Batch APIジョブ一覧（サーバー名・対象メッセージ/動画件数付き）';
COMMENT ON COLUMN v_gemini_batches.name IS 'Gemini Batch APIのジョブ名（batches/...）';
COMMENT ON COLUMN v_gemini_batches.kind IS 'バッチ種別（embedding / youtube_summary）';
COMMENT ON COLUMN v_gemini_batches.model IS 'バッチ処理に使用するGeminiモデル名';
COMMENT ON COLUMN v_gemini_batches.guild_id IS 'リクエスト元のDiscordサーバーID';
COMMENT ON COLUMN v_gemini_batches.guild_name IS 'リクエスト元のDiscordサーバー名';
COMMENT ON COLUMN v_gemini_batches.channel_id IS '完了通知先のDiscordチャンネルID';
COMMENT ON COLUMN v_gemini_batches.requester_id IS '実行ユーザーのDiscordユーザーID';
COMMENT ON COLUMN v_gemini_batches.item_count IS 'バッチに含まれる対象メッセージまたは動画の件数';
COMMENT ON COLUMN v_gemini_batches.state IS '最終確認時点のジョブ状態';
COMMENT ON COLUMN v_gemini_batches.checked_at IS 'ジョブ状態の最終確認日時';
COMMENT ON COLUMN v_gemini_batches.last_error IS '直近の状態確認エラーメッセージ';
COMMENT ON COLUMN v_gemini_batches.created_at IS 'バッチジョブの作成日時';
