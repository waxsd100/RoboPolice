-- referenced_text held only the replied-to conversation, and was empty for a mention that was not a
-- reply. It is now prompt: the whole request as sent to the AI (the server's information, the
-- recent talk, the replied-to conversation, the member's request itself), so what the AI was asked
-- is in the log whatever the mention was. `request` stays what the member wrote.
ALTER TABLE mention_logs RENAME COLUMN referenced_text TO prompt;
COMMENT ON COLUMN mention_logs.request IS 'メンバーが書いた依頼文（メンション部分を除く）';
COMMENT ON COLUMN mention_logs.prompt IS 'AI に送った依頼の本文すべて（サーバーの情報・チャンネルの最近の会話・返信先の会話・依頼文など。システム指示は mention_ai_calls・mention_ai_systems）';

DROP VIEW IF EXISTS v_mention_logs;
CREATE VIEW v_mention_logs AS
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
COMMENT ON COLUMN v_mention_logs.request IS 'メンバーが書いた依頼文（メンション部分を除く）';
COMMENT ON COLUMN v_mention_logs.prompt IS 'AI に送った依頼の本文すべて（サーバーの情報・最近の会話・返信先・依頼文など）';
COMMENT ON COLUMN v_mention_logs.response IS 'Botが送信した応答テキスト';
COMMENT ON COLUMN v_mention_logs.prompt_tokens IS '入力プロンプトトークン数';
COMMENT ON COLUMN v_mention_logs.cached_tokens IS 'キャッシュヒットした入力トークン数';
COMMENT ON COLUMN v_mention_logs.output_tokens IS '出力トークン数';
COMMENT ON COLUMN v_mention_logs.thinking_tokens IS '思考トークン数';
COMMENT ON COLUMN v_mention_logs.total_tokens IS '総消費トークン数（入力＋出力＋思考）';
COMMENT ON COLUMN v_mention_logs.gemini_calls IS 'Gemini API呼び出し回数';
COMMENT ON COLUMN v_mention_logs.created_at IS '応答ログ記録日時';
COMMENT ON COLUMN v_mention_logs.block_reason IS 'Google が依頼を拒否したときの理由';
COMMENT ON COLUMN v_mention_logs.fallbacks IS '途中で切り替えたこと（聞き直し・引き継ぎなど）';
COMMENT ON COLUMN v_mention_logs.context IS '依頼と一緒に送ったものと、sokudan が送る前に外したもの';
COMMENT ON COLUMN v_mention_logs.ai_calls IS 'AI を呼んだ回数（中身は v_mention_ai_calls・v_mention_ai_messages）';

-- ============================================================================
-- v_mention_ai_calls: メンションごとの AI の呼び出し（1行1回）
-- ============================================================================
CREATE VIEW v_mention_ai_calls AS
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
  (SELECT string_agg(r->>'category' || ':' || COALESCE(r->>'probability', '?'), ', ')
     FROM jsonb_array_elements(COALESCE(a.safety_ratings, '[]'::jsonb)) r
     WHERE (r->>'blocked')::boolean IS TRUE) AS blocked_by,
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
  a.error
FROM mention_ai_calls a
JOIN mention_logs l ON l.id = a.mention_log_id
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN mention_ai_systems s ON s.hash = a.system_hash;

COMMENT ON VIEW v_mention_ai_calls IS 'メンションのために AI を呼んだ1回ごとの一覧（どのメンションか・止まった理由と安全判定・返ってきた内容の先頭）。mention_log_id・seq の順に読む';
COMMENT ON COLUMN v_mention_ai_calls.mention_log_id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_ai_calls.mention_at IS 'メンションの日時';
COMMENT ON COLUMN v_mention_ai_calls.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN v_mention_ai_calls.guild_name IS 'Discordサーバー名';
COMMENT ON COLUMN v_mention_ai_calls.user_name IS '依頼したメンバーの名前';
COMMENT ON COLUMN v_mention_ai_calls.request IS 'メンバーが書いた依頼文';
COMMENT ON COLUMN v_mention_ai_calls.mention_kind IS 'メンションの結果（chat・refused など）';
COMMENT ON COLUMN v_mention_ai_calls.seq IS 'そのメンションの中での呼び出しの順番（0 から）';
COMMENT ON COLUMN v_mention_ai_calls.call_id IS '呼び出しID（mention_ai_calls.id。v_mention_ai_messages.call_id と同じ）';
COMMENT ON COLUMN v_mention_ai_calls.called_at IS '呼び出した日時';
COMMENT ON COLUMN v_mention_ai_calls.model IS '呼び出した AI モデル';
COMMENT ON COLUMN v_mention_ai_calls.purpose IS '何のための呼び出しか';
COMMENT ON COLUMN v_mention_ai_calls.finish_reason IS '返事が終わった理由（STOP・SAFETY など）';
COMMENT ON COLUMN v_mention_ai_calls.block_reason IS '依頼そのものが拒否されたときの理由';
COMMENT ON COLUMN v_mention_ai_calls.blocked_by IS '止めた安全カテゴリと確率（例: HARM_CATEGORY_SEXUALLY_EXPLICIT:LOW）';
COMMENT ON COLUMN v_mention_ai_calls.safety_ratings IS '安全判定の内訳すべて';
COMMENT ON COLUMN v_mention_ai_calls.safety_settings IS '送った安全設定（カテゴリごとの閾値）';
COMMENT ON COLUMN v_mention_ai_calls.tool_count IS '渡したツールの数';
COMMENT ON COLUMN v_mention_ai_calls.tools IS '渡したツールの名前';
COMMENT ON COLUMN v_mention_ai_calls.sent_messages IS 'この呼び出しで新しく送ったメッセージの数';
COMMENT ON COLUMN v_mention_ai_calls.received IS '返ってきた内容（種類と先頭 200 文字、1行1つ）';
COMMENT ON COLUMN v_mention_ai_calls.system_hash IS 'システム指示（mention_ai_systems.hash）';
COMMENT ON COLUMN v_mention_ai_calls.system_head IS 'システム指示の先頭 200 文字（全文は mention_ai_systems.text）';
COMMENT ON COLUMN v_mention_ai_calls.cached_content IS '使った Gemini のキャッシュの名前';
COMMENT ON COLUMN v_mention_ai_calls.generation_config IS '送った生成の設定';
COMMENT ON COLUMN v_mention_ai_calls.usage IS 'トークン数';
COMMENT ON COLUMN v_mention_ai_calls.error IS '呼び出しが失敗したときのエラー';

-- ============================================================================
-- v_mention_ai_messages: AI とのやり取りを1メッセージずつ、時系列に
-- ============================================================================
CREATE VIEW v_mention_ai_messages AS
SELECT
  a.mention_log_id,
  a.seq AS call_seq,
  m.seq,
  m.call_id,
  a.model,
  a.purpose,
  m.direction,
  m.turn,
  m.role,
  m.kind,
  m.name,
  length(m.content) AS length,
  m.content
FROM mention_ai_messages m
JOIN mention_ai_calls a ON a.id = m.call_id;

COMMENT ON VIEW v_mention_ai_messages IS 'AI に送ったメッセージと返ってきたメッセージを1件ずつ（mention_log_id・call_seq・seq の順に読むと、やり取りの流れになる。送った分は前の呼び出しから増えた分だけ）';
COMMENT ON COLUMN v_mention_ai_messages.mention_log_id IS 'メンションログID（mention_logs.id）';
COMMENT ON COLUMN v_mention_ai_messages.call_seq IS 'そのメンションの中での呼び出しの順番';
COMMENT ON COLUMN v_mention_ai_messages.seq IS 'その呼び出しの中での順番';
COMMENT ON COLUMN v_mention_ai_messages.call_id IS '呼び出しID（v_mention_ai_calls.call_id）';
COMMENT ON COLUMN v_mention_ai_messages.model IS '呼び出した AI モデル';
COMMENT ON COLUMN v_mention_ai_messages.purpose IS '何のための呼び出しか';
COMMENT ON COLUMN v_mention_ai_messages.direction IS 'sent: AI に送った / received: AI から返ってきた';
COMMENT ON COLUMN v_mention_ai_messages.turn IS '会話の中での番号（送ったメッセージだけ。0 が最初の依頼）';
COMMENT ON COLUMN v_mention_ai_messages.role IS '話し手（user・model・system・assistant・tool）';
COMMENT ON COLUMN v_mention_ai_messages.kind IS '種類（text・thought・function_call・function_response・picture）';
COMMENT ON COLUMN v_mention_ai_messages.name IS 'ツールの名前';
COMMENT ON COLUMN v_mention_ai_messages.length IS '本文の文字数';
COMMENT ON COLUMN v_mention_ai_messages.content IS '本文（ツールの引数・結果は JSON、画像は種類と大きさだけ）';
