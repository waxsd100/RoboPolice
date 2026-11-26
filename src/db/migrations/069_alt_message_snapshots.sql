-- Preserves deleted and pre-edit message snapshots (with moderator vs self deletion actor)
-- for AI alt-account detection, countering delete-and-repost evasion and retaining
-- moderator-deleted rule-breaking messages for stylometric and AI comparison.

CREATE TABLE IF NOT EXISTS alt_message_snapshots (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  channel_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('deleted', 'edited')),
  deleted_by TEXT NOT NULL DEFAULT 'unknown' CHECK (deleted_by IN ('self', 'moderator', 'unknown')),
  moderator_id TEXT,
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
COMMENT ON COLUMN alt_message_snapshots.deleted_by IS '削除主体（self: 本人削除 / moderator: モデレーター・一括削除 / unknown: 不明または編集）';
COMMENT ON COLUMN alt_message_snapshots.moderator_id IS 'モデレーター削除時に監査ログから特定した実行者のDiscordユーザーID';
COMMENT ON COLUMN alt_message_snapshots.content IS '削除・編集前のメッセージ本文';
COMMENT ON COLUMN alt_message_snapshots.original_ts IS '元のメッセージ送信日時';
COMMENT ON COLUMN alt_message_snapshots.event_ts IS '削除または編集が検知された日時';
