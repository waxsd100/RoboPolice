-- Mentions that continue a conversation by replying (to the bot's answer, or to an earlier
-- mention) form trees of any depth, which branch when several members reply to the same answer.
-- mention_logs.parent_id is the mention a mention replied to; mention_log_tree is the closure of
-- that: one row for every mention and each of its ancestors (and itself, at depth 0), so a whole
-- conversation, or everything that followed one mention, is one indexed lookup.

ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES mention_logs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS mention_logs_parent ON mention_logs (parent_id);
COMMENT ON COLUMN mention_logs.parent_id IS 'このメンションが返信した先のメンション（BOT の返事、または前のメンションへの返信のとき）。返信でなければ NULL';

CREATE TABLE mention_log_tree (
  ancestor_id   BIGINT NOT NULL REFERENCES mention_logs(id) ON DELETE CASCADE,
  descendant_id BIGINT NOT NULL REFERENCES mention_logs(id) ON DELETE CASCADE,
  depth         INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX mention_log_tree_descendant ON mention_log_tree (descendant_id, depth);

COMMENT ON TABLE mention_log_tree IS 'メンション同士の返信のつながりの閉包テーブル（祖先と子孫の組すべて。自分自身も深さ 0 で入る）。会話のスレッドは v_mention_threads で見る';
COMMENT ON COLUMN mention_log_tree.ancestor_id IS '祖先のメンション（mention_logs.id）';
COMMENT ON COLUMN mention_log_tree.descendant_id IS '子孫のメンション（mention_logs.id）';
COMMENT ON COLUMN mention_log_tree.depth IS '祖先から何段下か（自分自身は 0、直接の返信は 1）';

-- ============================================================================
-- v_mention_threads: 返信でつながった会話を、最初のメンションごとに
-- ============================================================================
CREATE VIEW v_mention_threads AS
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
  (SELECT count(*) FROM mention_ai_calls a WHERE a.mention_log_id = l.id) AS ai_calls
FROM mention_logs l
JOIN LATERAL (
  SELECT t.ancestor_id, t.depth FROM mention_log_tree t
  WHERE t.descendant_id = l.id ORDER BY t.depth DESC LIMIT 1
) root ON true
LEFT JOIN guilds g ON g.id = l.guild_id;

COMMENT ON VIEW v_mention_threads IS '返信でつながったメンションの会話（thread_id が最初のメンション。thread_id・depth・created_at の順に読むと会話の流れになる。枝分かれしたときは同じ depth に複数）';
COMMENT ON COLUMN v_mention_threads.thread_id IS '会話の最初のメンション（mention_logs.id）';
COMMENT ON COLUMN v_mention_threads.depth IS '最初のメンションから何段下か（最初は 0）';
COMMENT ON COLUMN v_mention_threads.mention_log_id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_threads.parent_id IS '返信した先のメンション（mention_logs.id）';
COMMENT ON COLUMN v_mention_threads.created_at IS 'メンションの日時';
COMMENT ON COLUMN v_mention_threads.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_mention_threads.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_mention_threads.channel_id IS 'DiscordチャンネルID';
COMMENT ON COLUMN v_mention_threads.user_name IS '依頼したメンバーの名前';
COMMENT ON COLUMN v_mention_threads.kind IS '応答の種類（chat・refused など）';
COMMENT ON COLUMN v_mention_threads.request IS 'メンバーが書いた依頼文';
COMMENT ON COLUMN v_mention_threads.response IS 'BOT が返した内容';
COMMENT ON COLUMN v_mention_threads.block_reason IS 'Google が拒否したときの理由';
COMMENT ON COLUMN v_mention_threads.model IS '応答に使った AI モデル';
COMMENT ON COLUMN v_mention_threads.ai_calls IS 'AI を呼んだ回数（中身は v_mention_ai_calls・v_mention_ai_messages）';
