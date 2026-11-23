-- Add latest Gemini 4 models to reply_model enum (must stay in order with REPLY_MODELS in
-- src/bot/utils/replyOptions.js; tested by test/db/migrations.test.js).
ALTER TYPE reply_model ADD VALUE IF NOT EXISTS 'gemini-4-hydrogen' AFTER 'gemini-3.8-flash';
ALTER TYPE reply_model ADD VALUE IF NOT EXISTS 'gemini-4-neon' AFTER 'gemini-4-hydrogen';
ALTER TYPE reply_model ADD VALUE IF NOT EXISTS 'gemini-4-carbon' AFTER 'gemini-4-neon';
