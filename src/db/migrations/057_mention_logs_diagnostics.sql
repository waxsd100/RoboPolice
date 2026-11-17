-- What a mention log needs to tell why Google refused a request: the block reason, what the bot
-- did about it (asked again without some parts, handed it over), and what went with the request.
ALTER TABLE mention_logs
  ADD COLUMN IF NOT EXISTS block_reason TEXT,
  ADD COLUMN IF NOT EXISTS fallbacks TEXT,
  ADD COLUMN IF NOT EXISTS context TEXT;

COMMENT ON COLUMN mention_logs.block_reason IS 'Google が依頼を拒否したときの理由（PROHIBITED_CONTENT・SAFETY など）。拒否されなかったときは NULL';
COMMENT ON COLUMN mention_logs.fallbacks IS '途中で切り替えたこと（例: 依頼文だけで聞き直した・検閲なしモデルへ引き継いだ）。; 区切り';
COMMENT ON COLUMN mention_logs.context IS '依頼と一緒に Gemini へ送ったもの（server・recent・conversation・members・pictures など）と、sokudan が送る前に外したもの';
