-- Each server's own model and thinking level for mention replies (%replymodel). NULL is the default
-- (GEMINI_MODEL, GEMINI_THINKING_LEVEL). The stronger model (think_deeper) is not changed.
ALTER TABLE guilds
  ADD COLUMN reply_model TEXT CHECK (reply_model ~ '^gemini-[a-z0-9.-]+$'),
  ADD COLUMN reply_thinking TEXT CHECK (reply_thinking IN ('minimal', 'low', 'medium', 'high'));
