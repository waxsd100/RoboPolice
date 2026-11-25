-- Drop guilds.assistant_rules (retired /assistantrules command and serverRules detection)
-- and remove retired ai_task enum values ('rules', 'blurb'), recreating dependent views
-- v_guilds and v_guild_ai_models with full schema comments.

DROP VIEW IF EXISTS v_guilds;
DROP VIEW IF EXISTS v_guild_ai_models;

ALTER TABLE guilds
  DROP COLUMN IF EXISTS assistant_rules;

DELETE FROM guild_ai_models WHERE task IN ('rules', 'blurb');

CREATE TYPE ai_task_new AS ENUM ('reply', 'light', 'extract', 'summary');
ALTER TABLE guild_ai_models
  ALTER COLUMN task TYPE ai_task_new USING task::text::ai_task_new;
DROP TYPE ai_task;
ALTER TYPE ai_task_new RENAME TO ai_task;

COMMENT ON TYPE ai_task IS 'サーバーごとにモデル・思考レベル・推論ティアを設定可能なAI処理用途（reply / light / extract / summary）';
COMMENT ON TABLE guild_ai_models IS 'サーバーおよびAI処理用途（4種類）ごとのカスタムモデル・思考レベル・推論ティア設定';
COMMENT ON COLUMN guild_ai_models.task IS 'AI処理の用途区分（reply / light / extract / summary）';

CREATE VIEW v_guilds AS
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
COMMENT ON COLUMN v_guilds.has_lore_style IS 'サーバーの話し方・雰囲気要約が生成済みかどうか';
COMMENT ON COLUMN v_guilds.details_updated_at IS 'サーバー基本情報の最終更新日時';

CREATE VIEW v_guild_ai_models AS
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
COMMENT ON COLUMN v_guild_ai_models.task IS 'AIタスク種別（reply / light / extract / summary）';
COMMENT ON COLUMN v_guild_ai_models.model IS '使用モデル設定（NULLはデフォルト）';
COMMENT ON COLUMN v_guild_ai_models.thinking IS '思考レベル設定（NULLはデフォルト）';
COMMENT ON COLUMN v_guild_ai_models.tier IS '推論ティア設定（standard / flex、NULLはデフォルト）';
