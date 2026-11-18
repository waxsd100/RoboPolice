-- A mention's log is made when the mention arrives, not when it is done, and says where it stands:
-- received (just arrived), generating (the AI is at work, or the result is being posted), waiting
-- (for the requester to answer a question or confirm a draft), done (answered, refused, cancelled
-- or failed: `kind` says which). Its AI calls are written as they are made. So a mention still being
-- handled, or one that never finished (the bot restarted, say), is in the log too.
-- kind and response are empty until the mention is done.
ALTER TABLE mention_logs ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE mention_logs ALTER COLUMN response DROP NOT NULL;
-- Mentions already logged were logged when they were done.
ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done'
  CHECK (status IN ('received', 'generating', 'waiting', 'done'));
ALTER TABLE mention_logs ALTER COLUMN status SET DEFAULT 'received';
ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
UPDATE mention_logs SET updated_at = created_at, finished_at = created_at WHERE status = 'done' AND finished_at IS NULL;
CREATE INDEX IF NOT EXISTS mention_logs_unfinished ON mention_logs (updated_at) WHERE status <> 'done';

COMMENT ON COLUMN mention_logs.status IS '処理の状態（received: 受け付けた / generating: AI が考えている・結果を投稿している / waiting: 依頼者の回答・確認を待っている / done: 終わった。結果は kind）';
COMMENT ON COLUMN mention_logs.updated_at IS '最後に状態や AI の呼び出しが記録された日時';
COMMENT ON COLUMN mention_logs.finished_at IS '終わった日時（終わっていなければ NULL）';
COMMENT ON COLUMN mention_logs.kind IS '結果の種類（chat: チャット返信 / event: イベント登録・更新 / forum: フォーラム投稿・更新 / message: チャンネルへの書き込み・更新 / error: エラー / refused: 制限・拒否 / cancelled: キャンセル・タイムアウト）。終わるまでは NULL';
COMMENT ON COLUMN mention_logs.response IS 'BOT が最終的に返した内容（返信・作成結果・エラーメッセージ）。終わるまでは NULL、何も返さなかったときも NULL';

-- A mention not done that has had nothing recorded for 30 minutes (longer than any one AI call or
-- wait for the requester) was cut off: shown as interrupted.
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
  l.prompt,
  l.response,
  l.prompt_tokens,
  l.cached_tokens,
  l.output_tokens,
  l.thinking_tokens,
  (l.prompt_tokens + l.output_tokens + l.thinking_tokens) AS total_tokens,
  l.gemini_calls,
  l.block_reason,
  l.fallbacks,
  l.context,
  (SELECT count(*) FROM mention_ai_calls a WHERE a.mention_log_id = l.id) AS ai_calls,
  l.created_at,
  l.follow_up_message_ids,
  l.parent_id,
  CASE WHEN l.status <> 'done' AND l.updated_at < now() - INTERVAL '30 minutes' THEN 'interrupted' ELSE l.status END AS status,
  l.updated_at,
  l.finished_at,
  EXTRACT(EPOCH FROM (COALESCE(l.finished_at, l.updated_at) - l.created_at))::numeric(10, 1) AS seconds
FROM mention_logs l
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN discord_channels c ON c.id = l.channel_id;

COMMENT ON COLUMN v_mention_logs.kind IS '結果の種類（chat / event / forum / message / error / refused / cancelled）。終わるまでは NULL';
COMMENT ON COLUMN v_mention_logs.response IS 'BOT が返した内容。終わるまでは NULL';
COMMENT ON COLUMN v_mention_logs.created_at IS 'メンションが届いた日時';
COMMENT ON COLUMN v_mention_logs.status IS '処理の状態（received・generating・waiting・done。終わらないまま 30 分以上何も記録されていなければ interrupted）';
COMMENT ON COLUMN v_mention_logs.updated_at IS '最後に状態や AI の呼び出しが記録された日時';
COMMENT ON COLUMN v_mention_logs.finished_at IS '終わった日時（終わっていなければ NULL）';
COMMENT ON COLUMN v_mention_logs.seconds IS '届いてから終わるまで（終わっていなければ最後の記録まで）の秒数';

CREATE OR REPLACE VIEW v_mention_threads AS
SELECT
  root.ancestor_id AS thread_id,
  root.depth,
  l.id AS mention_log_id,
  l.parent_id,
  l.created_at,
  l.guild_id,
  g.name AS guild_name,
  l.channel_id,
  l.user_name,
  l.kind,
  l.request,
  l.response,
  l.block_reason,
  l.model,
  (SELECT count(*) FROM mention_ai_calls a WHERE a.mention_log_id = l.id) AS ai_calls,
  CASE WHEN l.status <> 'done' AND l.updated_at < now() - INTERVAL '30 minutes' THEN 'interrupted' ELSE l.status END AS status
FROM mention_logs l
JOIN LATERAL (
  SELECT t.ancestor_id, t.depth FROM mention_log_tree t
  WHERE t.descendant_id = l.id ORDER BY t.depth DESC LIMIT 1
) root ON true
LEFT JOIN guilds g ON g.id = l.guild_id;

COMMENT ON COLUMN v_mention_threads.status IS '処理の状態（received・generating・waiting・done・interrupted）';
