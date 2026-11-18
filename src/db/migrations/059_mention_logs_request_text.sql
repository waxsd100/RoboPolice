-- referenced_text held only the replied-to conversation, and was empty for a mention that was not a
-- reply. It is now request_text: the whole request as sent to the AI (the server's information,
-- the recent talk, the replied-to conversation, the request itself), so what the AI was asked is
-- in the log whatever the mention was.
ALTER TABLE mention_logs RENAME COLUMN referenced_text TO request_text;
COMMENT ON COLUMN mention_logs.request_text IS 'AI に送った依頼の本文すべて（サーバーの情報・チャンネルの最近の会話・返信先の会話・依頼文など。システム指示は ai_transcript）';

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
  l.request_text,
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
  l.ai_transcript,
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
COMMENT ON COLUMN v_mention_logs.request IS 'ユーザーの質問テキスト';
COMMENT ON COLUMN v_mention_logs.request_text IS 'AI に送った依頼の本文すべて（サーバーの情報・最近の会話・返信先・依頼文など）';
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
COMMENT ON COLUMN v_mention_logs.ai_transcript IS 'AI に送った内容と返ってきた内容のすべて（呼び出しごと）';
