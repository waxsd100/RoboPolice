-- What the mention log left out:
-- - Every AI call is now recorded, not only the reply's steps: embeddings, Gemini's cache, the
--   uncensored model's retries. mention_ai_calls.attempts is how many times a call was sent
--   (retries after HTTP 429 included), so a mention's attempts add up to gemini_calls.
-- - A long chat reply is sent as several messages; only the first was kept, so a reply to a later
--   one did not find the mention it continues. follow_up_message_ids keeps the rest.
ALTER TABLE mention_ai_calls ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1);
COMMENT ON COLUMN mention_ai_calls.attempts IS '送った回数（HTTP 429 などで送り直した分を含む。メンションの合計が mention_logs.gemini_calls）';
COMMENT ON COLUMN mention_ai_calls.purpose IS '何のための呼び出しか（mention・mention-deep・uncensored・embedding・cache・replyPolish・image-describe など）';

ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS follow_up_message_ids TEXT[];
COMMENT ON COLUMN mention_logs.follow_up_message_ids IS 'BOT の返事が長くて複数のメッセージに分かれたときの、2つ目以降のメッセージのID（1つ目は reply_message_id）';
COMMENT ON COLUMN mention_logs.gemini_calls IS 'このメンションで AI に送ったリクエストの数（Gemini・検閲なしモデル・埋め込み・キャッシュ作成・送り直しを含む。内訳は v_mention_ai_calls）';
COMMENT ON COLUMN mention_logs.context IS '依頼と一緒に Gemini へ送ったもの（server・recent・conversation・members・pictures など）';

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
  l.parent_id
FROM mention_logs l
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN discord_channels c ON c.id = l.channel_id;

COMMENT ON COLUMN v_mention_logs.gemini_calls IS 'AI に送ったリクエストの数（送り直しを含む。v_mention_ai_calls の attempts の合計）';
COMMENT ON COLUMN v_mention_logs.context IS '依頼と一緒に Gemini へ送ったもの';
COMMENT ON COLUMN v_mention_logs.ai_calls IS 'AI を呼んだ回数（送り直しは1回と数える。中身は v_mention_ai_calls・v_mention_ai_messages）';
COMMENT ON COLUMN v_mention_logs.follow_up_message_ids IS 'BOT の返事が複数のメッセージに分かれたときの、2つ目以降のメッセージのID';
COMMENT ON COLUMN v_mention_logs.parent_id IS '返信した先のメンション（mention_logs.id。会話全体は v_mention_threads）';

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
  a.error,
  a.attempts
FROM mention_ai_calls a
JOIN mention_logs l ON l.id = a.mention_log_id
LEFT JOIN guilds g ON g.id = l.guild_id
LEFT JOIN mention_ai_systems s ON s.hash = a.system_hash;

COMMENT ON COLUMN v_mention_ai_calls.purpose IS '何のための呼び出しか（mention・uncensored・embedding・cache など）';
COMMENT ON COLUMN v_mention_ai_calls.attempts IS '送った回数（送り直した分を含む）';
