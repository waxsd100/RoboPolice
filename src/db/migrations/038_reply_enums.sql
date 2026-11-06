-- The models and thinking levels a server can set for mention replies (%replymodel) and the reply
-- lengths (/replylength) as enum types, in place of text checked against a pattern. The same lists
-- are in src/bot/utils/replyOptions.js; a model added there needs `ALTER TYPE reply_model ADD VALUE`
-- here too (test/db/migrations.test.js checks they agree).
CREATE TYPE reply_model AS ENUM ('gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite');
CREATE TYPE thinking_level AS ENUM ('minimal', 'low', 'medium', 'high');
CREATE TYPE reply_length AS ENUM ('long', 'normal', 'short');

ALTER TABLE guilds
  DROP CONSTRAINT IF EXISTS guilds_reply_model_check,
  DROP CONSTRAINT IF EXISTS guilds_reply_thinking_check,
  DROP CONSTRAINT IF EXISTS guilds_reply_length_check;

-- A model no longer offered goes back to the default.
UPDATE guilds SET reply_model = NULL
  WHERE reply_model IS NOT NULL AND NOT reply_model = ANY (enum_range(NULL::reply_model)::text[]);

ALTER TABLE guilds
  ALTER COLUMN reply_model TYPE reply_model USING reply_model::reply_model,
  ALTER COLUMN reply_thinking TYPE thinking_level USING reply_thinking::thinking_level,
  ALTER COLUMN reply_length TYPE reply_length USING reply_length::reply_length;
