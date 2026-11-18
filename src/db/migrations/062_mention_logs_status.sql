-- A mention's log is made when the mention arrives, not when it is done, and says where it stands:
-- received (just arrived), generating (the AI is at work, or the result is being posted), waiting
-- (for the requester to answer a question or confirm a draft), done (answered, refused or
-- cancelled: `kind` says which) or failed (it ended in an error). Its AI calls are written as they
-- are made. So a mention still being handled, or one that never finished (the bot restarted, say),
-- is in the log too. kind and response are empty until the mention has ended.
--
-- What most mentions do not have is no longer a column left empty in most rows, but rows of its
-- own: what happened along the way (each status, each fallback, a refusal by Google) in
-- mention_log_events, the further messages of a long answer in mention_log_follow_ups. A mention's
-- parent is in mention_log_tree already (depth 1). The views show all of it as before.

-- ============================================================================
-- mention_log_events: what happened while a mention was handled, in order
-- ============================================================================
CREATE TABLE mention_log_events (
  id             BIGSERIAL PRIMARY KEY,
  mention_log_id BIGINT NOT NULL REFERENCES mention_logs(id) ON DELETE CASCADE,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  event          TEXT NOT NULL CHECK (event IN ('status', 'fallback', 'refused')),
  detail         TEXT NOT NULL
);
CREATE INDEX mention_log_events_log ON mention_log_events (mention_log_id, id);

COMMENT ON TABLE mention_log_events IS 'メンションを処理する間に起きたこと（状態が変わった・途中で切り替えた・Google に拒否された）を1件1行で、起きた順に。v_mention_logs・v_mention_log_events で見る';
COMMENT ON COLUMN mention_log_events.id IS 'イベントの連番ID（起きた順）';
COMMENT ON COLUMN mention_log_events.mention_log_id IS 'どのメンションのことか（mention_logs.id）';
COMMENT ON COLUMN mention_log_events.at IS '起きた日時';
COMMENT ON COLUMN mention_log_events.event IS '何が起きたか（status: 状態が変わった / fallback: 途中で切り替えた・聞き直した / refused: Google に拒否された）';
COMMENT ON COLUMN mention_log_events.detail IS 'status は新しい状態（received・generating・waiting・done・failed）、fallback は何をどう切り替えたか、refused は拒否の理由（SAFETY・PROHIBITED_CONTENT など）';

-- ============================================================================
-- mention_log_follow_ups: the further messages of an answer split into several
-- ============================================================================
CREATE TABLE mention_log_follow_ups (
  message_id     TEXT PRIMARY KEY,
  mention_log_id BIGINT NOT NULL REFERENCES mention_logs(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  UNIQUE (mention_log_id, seq)
);

COMMENT ON TABLE mention_log_follow_ups IS 'BOT の返事が長くて複数のメッセージに分かれたときの、2つ目以降のメッセージ（1つ目は mention_logs.reply_message_id）';
COMMENT ON COLUMN mention_log_follow_ups.message_id IS 'BOT が送ったメッセージのID';
COMMENT ON COLUMN mention_log_follow_ups.mention_log_id IS 'どのメンションの返事か（mention_logs.id）';
COMMENT ON COLUMN mention_log_follow_ups.seq IS '返事の何つ目のメッセージか（2つ目が 1）';

-- What was in the columns, moved to their own rows.
INSERT INTO mention_log_follow_ups (message_id, mention_log_id, seq)
SELECT f.message_id, l.id, f.seq
FROM mention_logs l, unnest(l.follow_up_message_ids) WITH ORDINALITY AS f(message_id, seq)
WHERE l.follow_up_message_ids IS NOT NULL
ON CONFLICT (message_id) DO NOTHING;
INSERT INTO mention_log_events (mention_log_id, at, event, detail)
SELECT l.id, l.created_at, 'fallback', f.detail
FROM mention_logs l, regexp_split_to_table(l.fallbacks, '; ') WITH ORDINALITY AS f(detail, n)
WHERE l.fallbacks IS NOT NULL AND f.detail <> ''
ORDER BY l.id, f.n;
INSERT INTO mention_log_events (mention_log_id, at, event, detail)
SELECT id, created_at, 'refused', block_reason FROM mention_logs WHERE block_reason IS NOT NULL ORDER BY id;
-- Mentions already logged were logged when they had ended.
INSERT INTO mention_log_events (mention_log_id, at, event, detail)
SELECT id, created_at, 'status', CASE WHEN kind = 'error' THEN 'failed' ELSE 'done' END FROM mention_logs ORDER BY id;

DROP VIEW IF EXISTS v_mention_threads;
DROP VIEW IF EXISTS v_mention_logs;
ALTER TABLE mention_logs DROP COLUMN IF EXISTS follow_up_message_ids;
ALTER TABLE mention_logs DROP COLUMN IF EXISTS fallbacks;
ALTER TABLE mention_logs DROP COLUMN IF EXISTS block_reason;
DROP INDEX IF EXISTS mention_logs_parent;
ALTER TABLE mention_logs DROP COLUMN IF EXISTS parent_id;

ALTER TABLE mention_logs ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE mention_logs ALTER COLUMN response DROP NOT NULL;
ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS status TEXT;
UPDATE mention_logs SET status = CASE WHEN kind = 'error' THEN 'failed' ELSE 'done' END WHERE status IS NULL;
ALTER TABLE mention_logs ALTER COLUMN status SET NOT NULL;
ALTER TABLE mention_logs ALTER COLUMN status SET DEFAULT 'received';
ALTER TABLE mention_logs ADD CONSTRAINT mention_logs_status_check CHECK (status IN ('received', 'generating', 'waiting', 'done', 'failed'));
CREATE INDEX mention_logs_unfinished ON mention_logs (created_at) WHERE status NOT IN ('done', 'failed');

COMMENT ON COLUMN mention_logs.status IS '今の状態（received: 受け付けた / generating: AI が考えている・結果を投稿している / waiting: 依頼者の回答・確認を待っている / done: 終わった。結果は kind / failed: エラーで終わった）。移り変わりは mention_log_events';
COMMENT ON COLUMN mention_logs.kind IS '結果の種類（chat: チャット返信 / event: イベント登録・更新 / forum: フォーラム投稿・更新 / message: チャンネルへの書き込み・更新 / error: エラー / refused: 制限・拒否 / cancelled: キャンセル・タイムアウト）。終わるまでは NULL';
COMMENT ON COLUMN mention_logs.response IS 'BOT が最終的に返した内容（返信・作成結果・エラーメッセージ）。終わるまでは NULL、何も返さなかったときも NULL';

-- ============================================================================
-- v_mention_logs: メンションごとの一覧（状態・拒否の理由・切り替え・返事のメッセージ・親も）
-- ============================================================================
-- A mention not ended that has had nothing recorded for 30 minutes (longer than any one AI call or
-- wait for the requester) was cut off: shown as interrupted.
CREATE VIEW v_mention_logs AS
SELECT
  l.id,
  l.guild_id,
  g.name AS guild_name,
  l.channel_id,
  c.name AS channel_name,
  l.message_id,
  l.reply_message_id,
  f.follow_up_message_ids,
  p.parent_id,
  l.user_id,
  l.user_name,
  CASE WHEN l.status NOT IN ('done', 'failed') AND t.updated_at < now() - INTERVAL '30 minutes' THEN 'interrupted' ELSE l.status END AS status,
  l.kind,
  l.model,
  l.request,
  l.prompt,
  l.response,
  e.block_reason,
  e.fallbacks,
  l.context,
  l.prompt_tokens,
  l.cached_tokens,
  l.output_tokens,
  l.thinking_tokens,
  (l.prompt_tokens + l.output_tokens + l.thinking_tokens) AS total_tokens,
  l.gemini_calls,
  t.ai_calls,
  l.created_at,
  t.updated_at,
  e.finished_at,
  EXTRACT(EPOCH FROM (COALESCE(e.finished_at, t.updated_at) - l.created_at))::numeric(10, 1) AS seconds
FROM mention_logs l
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN discord_channels c ON c.id = l.channel_id
LEFT JOIN LATERAL (
  SELECT array_agg(u.message_id ORDER BY u.seq) AS follow_up_message_ids
  FROM mention_log_follow_ups u WHERE u.mention_log_id = l.id
) f ON true
LEFT JOIN LATERAL (
  SELECT r.ancestor_id AS parent_id FROM mention_log_tree r WHERE r.descendant_id = l.id AND r.depth = 1
) p ON true
LEFT JOIN LATERAL (
  SELECT
    (SELECT v.detail FROM mention_log_events v WHERE v.mention_log_id = l.id AND v.event = 'refused' ORDER BY v.id DESC LIMIT 1) AS block_reason,
    (SELECT string_agg(v.detail, '; ' ORDER BY v.id) FROM mention_log_events v WHERE v.mention_log_id = l.id AND v.event = 'fallback') AS fallbacks,
    (SELECT max(v.at) FROM mention_log_events v WHERE v.mention_log_id = l.id AND v.event = 'status' AND v.detail IN ('done', 'failed')) AS finished_at
) e ON true
LEFT JOIN LATERAL (
  SELECT
    (SELECT count(*) FROM mention_ai_calls a WHERE a.mention_log_id = l.id) AS ai_calls,
    GREATEST(
      l.created_at,
      (SELECT max(v.at) FROM mention_log_events v WHERE v.mention_log_id = l.id),
      (SELECT max(a.called_at) FROM mention_ai_calls a WHERE a.mention_log_id = l.id)
    ) AS updated_at
) t ON true;

COMMENT ON VIEW v_mention_logs IS 'メンションごとの一覧（今の状態・結果・拒否の理由・途中の切り替え・トークン数・かかった時間。サーバー名・チャンネル名付き）';
COMMENT ON COLUMN v_mention_logs.id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_logs.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_mention_logs.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_mention_logs.channel_id IS 'DiscordチャンネルID';
COMMENT ON COLUMN v_mention_logs.channel_name IS 'Discordチャンネル名';
COMMENT ON COLUMN v_mention_logs.message_id IS 'メンバーが送ったメンションのメッセージID';
COMMENT ON COLUMN v_mention_logs.reply_message_id IS 'BOT の返事のメッセージID（分かれたときは1つ目）';
COMMENT ON COLUMN v_mention_logs.follow_up_message_ids IS '返事が分かれたときの2つ目以降のメッセージID（mention_log_follow_ups。なければ NULL）';
COMMENT ON COLUMN v_mention_logs.parent_id IS '返信した先のメンション（mention_log_tree の深さ 1。返信でなければ NULL。会話全体は v_mention_threads）';
COMMENT ON COLUMN v_mention_logs.user_id IS '依頼したメンバーのDiscordユーザーID';
COMMENT ON COLUMN v_mention_logs.user_name IS '依頼したメンバーのユーザー名';
COMMENT ON COLUMN v_mention_logs.status IS '今の状態（received・generating・waiting・done・failed。終わらないまま 30 分以上何も記録されていなければ interrupted）';
COMMENT ON COLUMN v_mention_logs.kind IS '結果の種類（chat / event / forum / message / error / refused / cancelled）。終わるまでは NULL';
COMMENT ON COLUMN v_mention_logs.model IS '応答に使った AI モデル（引き継いだときは矢印区切り）';
COMMENT ON COLUMN v_mention_logs.request IS 'メンバーが書いた依頼文（メンション部分を除く）';
COMMENT ON COLUMN v_mention_logs.prompt IS 'AI に送った依頼の本文すべて（サーバーの情報・最近の会話・返信先・依頼文など）';
COMMENT ON COLUMN v_mention_logs.response IS 'BOT が返した内容。終わるまでは NULL';
COMMENT ON COLUMN v_mention_logs.block_reason IS 'Google が拒否したときの理由（mention_log_events の最後の refused。拒否されていなければ NULL）';
COMMENT ON COLUMN v_mention_logs.fallbacks IS '途中で切り替えたこと（聞き直し・引き継ぎなど。mention_log_events の fallback を順に。なければ NULL）';
COMMENT ON COLUMN v_mention_logs.context IS '依頼と一緒に Gemini へ送ったもの';
COMMENT ON COLUMN v_mention_logs.prompt_tokens IS '入力トークン数（合計）';
COMMENT ON COLUMN v_mention_logs.cached_tokens IS '入力トークンのうちキャッシュから使った数';
COMMENT ON COLUMN v_mention_logs.output_tokens IS '出力トークン数';
COMMENT ON COLUMN v_mention_logs.thinking_tokens IS '思考トークン数';
COMMENT ON COLUMN v_mention_logs.total_tokens IS '総トークン数（入力＋出力＋思考）';
COMMENT ON COLUMN v_mention_logs.gemini_calls IS 'AI に送ったリクエストの数（送り直しを含む。v_mention_ai_calls の attempts の合計）';
COMMENT ON COLUMN v_mention_logs.ai_calls IS 'AI を呼んだ回数（送り直しは1回と数える。中身は v_mention_ai_calls・v_mention_ai_messages）';
COMMENT ON COLUMN v_mention_logs.created_at IS 'メンションが届いた日時';
COMMENT ON COLUMN v_mention_logs.updated_at IS '最後に何か（状態・切り替え・AI の呼び出し）が記録された日時';
COMMENT ON COLUMN v_mention_logs.finished_at IS '終わった日時（終わっていなければ NULL）';
COMMENT ON COLUMN v_mention_logs.seconds IS '届いてから終わるまで（終わっていなければ最後の記録まで）の秒数';

-- ============================================================================
-- v_mention_log_events: メンションごとの、起きたことの流れ
-- ============================================================================
CREATE VIEW v_mention_log_events AS
SELECT
  v.mention_log_id,
  l.request,
  v.id AS event_id,
  v.at,
  v.event,
  v.detail,
  EXTRACT(EPOCH FROM (v.at - l.created_at))::numeric(10, 1) AS seconds
FROM mention_log_events v
JOIN mention_logs l ON l.id = v.mention_log_id;

COMMENT ON VIEW v_mention_log_events IS 'メンションを処理する間に起きたことの流れ（状態の移り変わり・途中の切り替え・拒否）。mention_log_id・event_id の順に読む';
COMMENT ON COLUMN v_mention_log_events.mention_log_id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_log_events.request IS 'メンバーが書いた依頼文';
COMMENT ON COLUMN v_mention_log_events.event_id IS 'イベントID（起きた順）';
COMMENT ON COLUMN v_mention_log_events.at IS '起きた日時';
COMMENT ON COLUMN v_mention_log_events.event IS '何が起きたか（status・fallback・refused）';
COMMENT ON COLUMN v_mention_log_events.detail IS '新しい状態、切り替えの内容、または拒否の理由';
COMMENT ON COLUMN v_mention_log_events.seconds IS 'メンションが届いてからの秒数';

-- ============================================================================
-- v_mention_threads: 返信でつながった会話を、最初のメンションごとに
-- ============================================================================
CREATE VIEW v_mention_threads AS
SELECT
  root.ancestor_id AS thread_id,
  root.depth,
  l.id AS mention_log_id,
  p.ancestor_id AS parent_id,
  l.created_at,
  l.guild_id,
  g.name AS guild_name,
  l.channel_id,
  l.user_name,
  l.status,
  l.kind,
  l.request,
  l.response,
  (SELECT v.detail FROM mention_log_events v WHERE v.mention_log_id = l.id AND v.event = 'refused' ORDER BY v.id DESC LIMIT 1) AS block_reason,
  l.model,
  (SELECT count(*) FROM mention_ai_calls a WHERE a.mention_log_id = l.id) AS ai_calls
FROM mention_logs l
JOIN LATERAL (
  SELECT t.ancestor_id, t.depth FROM mention_log_tree t
  WHERE t.descendant_id = l.id ORDER BY t.depth DESC LIMIT 1
) root ON true
LEFT JOIN mention_log_tree p ON p.descendant_id = l.id AND p.depth = 1
LEFT JOIN guilds g ON g.id = l.guild_id;

COMMENT ON VIEW v_mention_threads IS '返信でつながったメンションの会話（thread_id が最初のメンション。thread_id・depth・created_at の順に読むと会話の流れになる。枝分かれしたときは同じ depth に複数）';
COMMENT ON COLUMN v_mention_threads.thread_id IS '会話の最初のメンション（mention_logs.id）';
COMMENT ON COLUMN v_mention_threads.depth IS '最初のメンションから何段下か（最初は 0）';
COMMENT ON COLUMN v_mention_threads.mention_log_id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_threads.parent_id IS '返信した先のメンション（mention_logs.id。最初のメンションは NULL）';
COMMENT ON COLUMN v_mention_threads.created_at IS 'メンションが届いた日時';
COMMENT ON COLUMN v_mention_threads.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_mention_threads.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_mention_threads.channel_id IS 'DiscordチャンネルID';
COMMENT ON COLUMN v_mention_threads.user_name IS '依頼したメンバーの名前';
COMMENT ON COLUMN v_mention_threads.status IS '今の状態（received・generating・waiting・done・failed）';
COMMENT ON COLUMN v_mention_threads.kind IS '結果の種類（chat・refused など）。終わるまでは NULL';
COMMENT ON COLUMN v_mention_threads.request IS 'メンバーが書いた依頼文';
COMMENT ON COLUMN v_mention_threads.response IS 'BOT が返した内容';
COMMENT ON COLUMN v_mention_threads.block_reason IS 'Google が拒否したときの理由';
COMMENT ON COLUMN v_mention_threads.model IS '応答に使った AI モデル';
COMMENT ON COLUMN v_mention_threads.ai_calls IS 'AI を呼んだ回数（中身は v_mention_ai_calls・v_mention_ai_messages）';

-- ============================================================================
-- v_mention_ai_calls: blocked_by was empty when Google gave no `blocked` flag with its ratings, as
-- it often does: a call that ended in SAFETY now names each category rated at or above the
-- threshold it was sent with.
-- ============================================================================
CREATE OR REPLACE VIEW v_mention_ai_calls AS
SELECT
  a.mention_log_id,
  l.created_at AS mention_at,
  l.guild_id,
  g.name AS guild_name,
  l.user_name,
  l.request,
  l.kind AS mention_kind,
  a.seq,
  a.id AS call_id,
  a.called_at,
  a.model,
  a.purpose,
  a.finish_reason,
  a.block_reason,
  COALESCE(
    (SELECT string_agg(r->>'category' || ':' || COALESCE(r->>'probability', '?'), ', ')
       FROM jsonb_array_elements(COALESCE(a.safety_ratings, '[]'::jsonb)) r
       WHERE (r->>'blocked')::boolean IS TRUE),
    CASE WHEN a.finish_reason = 'SAFETY' THEN
      (SELECT string_agg(r->>'category' || ':' || (r->>'probability'), ', ')
         FROM jsonb_array_elements(COALESCE(a.safety_ratings, '[]'::jsonb)) r
         JOIN jsonb_array_elements(COALESCE(a.safety_settings, '[]'::jsonb)) s ON s->>'category' = r->>'category'
         WHERE (CASE r->>'probability' WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'HIGH' THEN 3 ELSE 0 END)
            >= (CASE s->>'threshold' WHEN 'BLOCK_LOW_AND_ABOVE' THEN 1 WHEN 'BLOCK_MEDIUM_AND_ABOVE' THEN 2 WHEN 'BLOCK_ONLY_HIGH' THEN 3 ELSE 99 END))
    END
  ) AS blocked_by,
  a.safety_ratings,
  a.safety_settings,
  array_length(a.tools, 1) AS tool_count,
  a.tools,
  (SELECT count(*) FROM mention_ai_messages m WHERE m.call_id = a.id AND m.direction = 'sent') AS sent_messages,
  (SELECT string_agg(m.kind || COALESCE('(' || m.name || ')', '') || ': ' || left(m.content, 200), E'\n' ORDER BY m.seq)
     FROM mention_ai_messages m WHERE m.call_id = a.id AND m.direction = 'received') AS received,
  a.system_hash,
  left(s.text, 200) AS system_head,
  a.cached_content,
  a.generation_config,
  a.usage,
  a.error,
  a.attempts
FROM mention_ai_calls a
JOIN mention_logs l ON l.id = a.mention_log_id
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN mention_ai_systems s ON s.hash = a.system_hash;

COMMENT ON COLUMN v_mention_ai_calls.blocked_by IS '止めた安全カテゴリと確率（例: HARM_CATEGORY_HARASSMENT:MEDIUM）。Google が blocked を付けていればそれ、なければ SAFETY で終わった呼び出しの、送った閾値以上と判定されたカテゴリ。PROHIBITED_CONTENT（設定では変えられない判定）は finish_reason・block_reason を見る';
