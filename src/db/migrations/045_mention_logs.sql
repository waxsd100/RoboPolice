-- Records each mention interaction (user request and bot response) for auditing and debugging.
CREATE TABLE mention_logs (
  id               BIGSERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  reply_message_id TEXT,
  user_id          TEXT NOT NULL,
  user_name        TEXT,
  kind             TEXT NOT NULL,
  request          TEXT NOT NULL,
  referenced_text  TEXT,
  response         TEXT NOT NULL,
  model            TEXT,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  thinking_tokens  INTEGER NOT NULL DEFAULT 0,
  gemini_calls     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mention_logs_guild_created ON mention_logs (guild_id, created_at DESC);
CREATE INDEX mention_logs_user_created ON mention_logs (user_id, created_at DESC);

COMMENT ON TABLE mention_logs IS 'BOTへのメンション（または返信）に対するリクエスト内容とBOTの発言（レスポンス）の履歴ログ';
COMMENT ON COLUMN mention_logs.id IS 'ログの一意な連番ID';
COMMENT ON COLUMN mention_logs.guild_id IS 'やり取りが行われたDiscordサーバーID（guilds.id）';
COMMENT ON COLUMN mention_logs.channel_id IS 'やり取りが行われたチャンネルID';
COMMENT ON COLUMN mention_logs.message_id IS '依頼者が送信した元メッセージのID';
COMMENT ON COLUMN mention_logs.reply_message_id IS 'BOTが返信として送信したメッセージのID';
COMMENT ON COLUMN mention_logs.user_id IS '依頼者のDiscordユーザーID';
COMMENT ON COLUMN mention_logs.user_name IS '依頼者のユーザー名';
COMMENT ON COLUMN mention_logs.kind IS '応答の種類（chat: チャット返信 / event: イベント登録・更新 / forum: フォーラム投稿・更新 / error: エラー / refused: 制限・拒否 / cancelled: キャンセル・タイムアウト）';
COMMENT ON COLUMN mention_logs.request IS '依頼者が送信したリクエスト本文（メンション部分を除いたテキスト）';
COMMENT ON COLUMN mention_logs.referenced_text IS '返信元のメッセージ・会話チェーンのテキスト（返信形式の場合）';
COMMENT ON COLUMN mention_logs.response IS 'BOTが最終的に返した発言内容（返信テキスト・作成結果・エラーメッセージ）';
COMMENT ON COLUMN mention_logs.model IS '応答に使用されたAIモデル名（複数モデルの引き継ぎ時は矢印区切り）';
COMMENT ON COLUMN mention_logs.prompt_tokens IS '消費した入力プロンプトトークン数（合計）';
COMMENT ON COLUMN mention_logs.cached_tokens IS '入力トークンのうちGeminiキャッシュから供給されたトークン数';
COMMENT ON COLUMN mention_logs.output_tokens IS '消費した出力（回答）トークン数';
COMMENT ON COLUMN mention_logs.thinking_tokens IS '消費した思考（Thinking）トークン数';
COMMENT ON COLUMN mention_logs.gemini_calls IS 'このメンション処理で行われたGemini API呼び出し回数';
COMMENT ON COLUMN mention_logs.created_at IS 'ログが記録された日時';
