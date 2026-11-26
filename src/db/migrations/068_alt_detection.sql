-- AI alt-account detection: per-guild toggle on guilds, member profile/moderation snapshots
-- (so banned/kicked/left users remain comparable after leaving Discord's member cache),
-- alert audit log for deduplication and review, author message index, and inspection views.

ALTER TABLE guilds
  ADD COLUMN IF NOT EXISTS alt_detection BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN guilds.alt_detection IS 'AIを利用したサブ垢（BAN/キック回避・同一人物）自動検知が有効かどうか';

CREATE TABLE IF NOT EXISTS member_activity_profiles (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  username TEXT,
  global_name TEXT,
  nick TEXT,
  avatar_hash TEXT,
  avatar_url TEXT,
  account_created_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ,
  invite_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'left', 'kicked', 'banned')),
  status_at TIMESTAMPTZ,
  moderation_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS member_activity_profiles_guild_status
  ON member_activity_profiles (guild_id, status, status_at DESC);
CREATE INDEX IF NOT EXISTS member_activity_profiles_guild_joined
  ON member_activity_profiles (guild_id, joined_at DESC);

COMMENT ON TABLE member_activity_profiles IS 'サブ垢検知・BAN/キック/違反者ロール回避照合用のサーバー別メンバープロフィール・入退室/処罰履歴スナップショット';
COMMENT ON COLUMN member_activity_profiles.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN member_activity_profiles.user_id IS 'DiscordユーザーID';
COMMENT ON COLUMN member_activity_profiles.username IS '記録時点のDiscordユーザー名';
COMMENT ON COLUMN member_activity_profiles.global_name IS '記録時点のグローバル表示名';
COMMENT ON COLUMN member_activity_profiles.nick IS '記録時点のサーバーニックネーム';
COMMENT ON COLUMN member_activity_profiles.avatar_hash IS '記録時点のアバターハッシュ（カスタムアイコン一致照合用）';
COMMENT ON COLUMN member_activity_profiles.avatar_url IS '記録時点のアバター画像URL（AI視覚比較用）';
COMMENT ON COLUMN member_activity_profiles.account_created_at IS 'Discordアカウントの作成日時';
COMMENT ON COLUMN member_activity_profiles.joined_at IS 'このサーバーへの参加日時';
COMMENT ON COLUMN member_activity_profiles.invite_code IS '参加時に使用された招待コード';
COMMENT ON COLUMN member_activity_profiles.status IS '現在の状態（active / restricted / left / kicked / banned）';
COMMENT ON COLUMN member_activity_profiles.status_at IS '退出・キック・BAN・違反者ロール付与が発生した日時';
COMMENT ON COLUMN member_activity_profiles.moderation_reason IS 'BAN・キック・違反者ロール付与時の理由';
COMMENT ON COLUMN member_activity_profiles.updated_at IS 'レコードの最終更新日時';

CREATE TABLE IF NOT EXISTS alt_alerts (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  suspect_user_id TEXT NOT NULL,
  candidate_user_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('join', 'messages', 'manual')),
  heuristic_score SMALLINT NOT NULL CHECK (heuristic_score BETWEEN 0 AND 100),
  ai_confidence SMALLINT CHECK (ai_confidence BETWEEN 0 AND 100),
  verdict TEXT NOT NULL CHECK (verdict IN ('likely_alt', 'possible_alt', 'unlikely', 'insufficient')),
  summary TEXT,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alt_alerts_guild_pair_created
  ON alt_alerts (guild_id, suspect_user_id, candidate_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS alt_alerts_guild_created
  ON alt_alerts (guild_id, created_at DESC);

COMMENT ON TABLE alt_alerts IS 'AIサブ垢検知のアラート通知・手動調査履歴（重複通知抑止およびスタッフ確認用）';
COMMENT ON COLUMN alt_alerts.id IS 'アラート連番ID';
COMMENT ON COLUMN alt_alerts.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN alt_alerts.suspect_user_id IS '調査対象（新規参加者・被疑者）のDiscordユーザーID';
COMMENT ON COLUMN alt_alerts.candidate_user_id IS '同一人物候補（BAN済みユーザーや既存メンバー）のDiscordユーザーID';
COMMENT ON COLUMN alt_alerts.trigger IS '検知トリガー（join: 参加時 / messages: 発言蓄積時 / manual: 手動コマンド）';
COMMENT ON COLUMN alt_alerts.heuristic_score IS '第1段階のルール・特徴量スコア（0〜100）';
COMMENT ON COLUMN alt_alerts.ai_confidence IS '第2段階のGemini AI判定確信度（0〜100、AI未使用時はNULL）';
COMMENT ON COLUMN alt_alerts.verdict IS '総合判定（likely_alt / possible_alt / unlikely / insufficient）';
COMMENT ON COLUMN alt_alerts.summary IS 'AIまたはルールによる判定根拠の要約';
COMMENT ON COLUMN alt_alerts.signals IS '検知に寄与した特徴量・根拠シグナル一覧（JSON配列）';
COMMENT ON COLUMN alt_alerts.created_at IS 'アラート記録日時';

CREATE TABLE IF NOT EXISTS alt_message_snapshots (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  channel_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('deleted', 'edited')),
  content TEXT NOT NULL,
  original_ts TIMESTAMPTZ,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alt_message_snapshots_guild_author_ts
  ON alt_message_snapshots (guild_id, author_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS alt_message_snapshots_guild_event_ts
  ON alt_message_snapshots (guild_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS alt_message_snapshots_message_id
  ON alt_message_snapshots (message_id);

COMMENT ON TABLE alt_message_snapshots IS '削除済み・編集前メッセージのスナップショット（モデレーター削除や消して再投稿によるサブ垢検知回避対策用）';
COMMENT ON COLUMN alt_message_snapshots.id IS 'スナップショット連番ID';
COMMENT ON COLUMN alt_message_snapshots.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN alt_message_snapshots.message_id IS '元のDiscordメッセージID';
COMMENT ON COLUMN alt_message_snapshots.author_id IS '送信者のDiscordユーザーID';
COMMENT ON COLUMN alt_message_snapshots.channel_id IS '送信されたチャンネルID';
COMMENT ON COLUMN alt_message_snapshots.event_type IS '種別（deleted: 削除済み / edited: 編集前の原文）';
COMMENT ON COLUMN alt_message_snapshots.content IS '削除・編集前のメッセージ本文';
COMMENT ON COLUMN alt_message_snapshots.original_ts IS '元のメッセージ送信日時';
COMMENT ON COLUMN alt_message_snapshots.event_ts IS '削除または編集が検知された日時';

CREATE INDEX IF NOT EXISTS messages_guild_author_ts
  ON messages (guild_id, author_id, ts DESC);

-- Recreate v_guilds to expose alt_detection alongside other server settings.
DROP VIEW IF EXISTS v_guilds;

CREATE VIEW v_guilds AS
SELECT
  g.id,
  g.name,
  g.owner_id,
  g.member_count,
  g.joined_at,
  g.log_bots,
  g.youtube_live_events,
  g.alt_detection,
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
COMMENT ON COLUMN v_guilds.alt_detection IS 'AIを利用したサブ垢自動検知が有効かどうか';
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

CREATE OR REPLACE VIEW v_alt_alerts AS
SELECT
  a.id,
  a.guild_id,
  g.name AS guild_name,
  a.suspect_user_id,
  sp.username AS suspect_username,
  a.candidate_user_id,
  cp.username AS candidate_username,
  cp.status AS candidate_status,
  a.trigger,
  a.heuristic_score,
  a.ai_confidence,
  a.verdict,
  a.summary,
  a.created_at
FROM alt_alerts a
JOIN guilds g ON g.id = a.guild_id
LEFT JOIN member_activity_profiles sp ON sp.guild_id = a.guild_id AND sp.user_id = a.suspect_user_id
LEFT JOIN member_activity_profiles cp ON cp.guild_id = a.guild_id AND cp.user_id = a.candidate_user_id;

COMMENT ON VIEW v_alt_alerts IS 'AIサブ垢検知のアラート・調査結果一覧（サーバー名・ユーザー名・候補ステータス付き）';
COMMENT ON COLUMN v_alt_alerts.id IS 'アラート連番ID';
COMMENT ON COLUMN v_alt_alerts.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_alt_alerts.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_alt_alerts.suspect_user_id IS '調査対象のDiscordユーザーID';
COMMENT ON COLUMN v_alt_alerts.suspect_username IS '調査対象の記録時点ユーザー名';
COMMENT ON COLUMN v_alt_alerts.candidate_user_id IS '同一人物候補のDiscordユーザーID';
COMMENT ON COLUMN v_alt_alerts.candidate_username IS '同一人物候補の記録時点ユーザー名';
COMMENT ON COLUMN v_alt_alerts.candidate_status IS '同一人物候補の状態（active / left / kicked / banned）';
COMMENT ON COLUMN v_alt_alerts.trigger IS '検知トリガー（join / messages / manual）';
COMMENT ON COLUMN v_alt_alerts.heuristic_score IS 'ルール・特徴量スコア（0〜100）';
COMMENT ON COLUMN v_alt_alerts.ai_confidence IS 'AI判定確信度（0〜100）';
COMMENT ON COLUMN v_alt_alerts.verdict IS '総合判定（likely_alt / possible_alt / unlikely / insufficient）';
COMMENT ON COLUMN v_alt_alerts.summary IS '判定根拠の要約';
COMMENT ON COLUMN v_alt_alerts.created_at IS 'アラート記録日時';
