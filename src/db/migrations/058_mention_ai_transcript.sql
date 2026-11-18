-- Everything sent to an AI model while a mention was handled, and what came back (aiTranscript.js),
-- so why a request was refused or answered as it was can be looked at afterwards:
--   mention_logs 1─* mention_ai_calls 1─* mention_ai_messages
--   mention_ai_calls *─1 mention_ai_systems (each set of system instructions is kept once)
-- Read them through v_mention_ai_calls and v_mention_ai_messages (059_mention_logs_prompt.sql).

CREATE TABLE mention_ai_systems (
  hash       TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mention_ai_calls (
  id                BIGSERIAL PRIMARY KEY,
  mention_log_id    BIGINT NOT NULL REFERENCES mention_logs(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  called_at         TIMESTAMPTZ NOT NULL,
  model             TEXT,
  purpose           TEXT,
  system_hash       TEXT REFERENCES mention_ai_systems(hash),
  cached_content    TEXT,
  tools             TEXT[],
  safety_settings   JSONB,
  generation_config JSONB,
  finish_reason     TEXT,
  block_reason      TEXT,
  safety_ratings    JSONB,
  usage             JSONB,
  error             TEXT,
  UNIQUE (mention_log_id, seq)
);
CREATE INDEX mention_ai_calls_system ON mention_ai_calls (system_hash);

CREATE TABLE mention_ai_messages (
  id        BIGSERIAL PRIMARY KEY,
  call_id   BIGINT NOT NULL REFERENCES mention_ai_calls(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
  turn      INTEGER,
  role      TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('text', 'thought', 'function_call', 'function_response', 'picture')),
  name      TEXT,
  content   TEXT,
  UNIQUE (call_id, seq)
);

COMMENT ON TABLE mention_ai_systems IS 'AI に送ったシステム指示（同じものは1回だけ）。mention_ai_calls.system_hash から参照';
COMMENT ON COLUMN mention_ai_systems.hash IS 'システム指示の本文の SHA-256（先頭16桁）';
COMMENT ON COLUMN mention_ai_systems.text IS 'システム指示の本文（長いものは 20000 文字で省略）';
COMMENT ON COLUMN mention_ai_systems.created_at IS '最初に保存した日時';

COMMENT ON TABLE mention_ai_calls IS 'メンション1件のあいだに AI を呼んだ1回ごとの記録（送った設定と、返ってきた結果）';
COMMENT ON COLUMN mention_ai_calls.id IS '呼び出しの連番ID';
COMMENT ON COLUMN mention_ai_calls.mention_log_id IS 'どのメンションのための呼び出しか（mention_logs.id）';
COMMENT ON COLUMN mention_ai_calls.seq IS 'そのメンションの中での呼び出しの順番（0 から）';
COMMENT ON COLUMN mention_ai_calls.called_at IS '呼び出した日時';
COMMENT ON COLUMN mention_ai_calls.model IS '呼び出した AI モデル';
COMMENT ON COLUMN mention_ai_calls.purpose IS '何のための呼び出しか（mention・mention-deep・replyPolish・uncensored など）';
COMMENT ON COLUMN mention_ai_calls.system_hash IS '送ったシステム指示（mention_ai_systems.hash）。キャッシュを使った呼び出しでも中身を指す';
COMMENT ON COLUMN mention_ai_calls.cached_content IS '使った Gemini のキャッシュの名前（使わなかったときは NULL）';
COMMENT ON COLUMN mention_ai_calls.tools IS '渡したツールの名前';
COMMENT ON COLUMN mention_ai_calls.safety_settings IS '送った安全設定（カテゴリごとの閾値）';
COMMENT ON COLUMN mention_ai_calls.generation_config IS '送った生成の設定（temperature・thinking など）';
COMMENT ON COLUMN mention_ai_calls.finish_reason IS '返事が終わった理由（STOP・SAFETY など）';
COMMENT ON COLUMN mention_ai_calls.block_reason IS '依頼そのものが拒否されたときの理由（PROHIBITED_CONTENT など）';
COMMENT ON COLUMN mention_ai_calls.safety_ratings IS '安全判定の内訳（カテゴリ・確率・止めたかどうか）';
COMMENT ON COLUMN mention_ai_calls.usage IS 'トークン数（usageMetadata）';
COMMENT ON COLUMN mention_ai_calls.error IS '呼び出しが失敗したときのエラー';

COMMENT ON TABLE mention_ai_messages IS 'AI に送ったメッセージと、返ってきたメッセージ（呼び出しごと。送った分は前の呼び出しから増えた分だけ）';
COMMENT ON COLUMN mention_ai_messages.id IS 'メッセージの連番ID';
COMMENT ON COLUMN mention_ai_messages.call_id IS 'どの呼び出しか（mention_ai_calls.id）';
COMMENT ON COLUMN mention_ai_messages.seq IS 'その呼び出しの中での順番';
COMMENT ON COLUMN mention_ai_messages.direction IS 'sent: AI に送った / received: AI から返ってきた';
COMMENT ON COLUMN mention_ai_messages.turn IS '会話の中での番号（送ったメッセージだけ。0 が最初の依頼）';
COMMENT ON COLUMN mention_ai_messages.role IS '話し手（user・model・system・assistant・tool）';
COMMENT ON COLUMN mention_ai_messages.kind IS '種類（text・thought・function_call・function_response・picture）';
COMMENT ON COLUMN mention_ai_messages.name IS 'ツールの名前（function_call・function_response のとき）';
COMMENT ON COLUMN mention_ai_messages.content IS '本文（ツールの引数・結果は JSON、画像は種類と大きさだけ。長いものは 20000 文字で省略）';
