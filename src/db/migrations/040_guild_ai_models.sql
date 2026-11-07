-- Each server's own model, thinking level and service tier (standard / flex) for each AI task
-- (%replymodel). NULL uses the task's default. The same task and tier lists are in
-- src/bot/utils/replyOptions.js.
CREATE TYPE ai_task AS ENUM ('reply', 'rules', 'blurb', 'light', 'extract', 'summary');
CREATE TYPE service_tier AS ENUM ('standard', 'flex');

CREATE TABLE guild_ai_models (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  task ai_task NOT NULL,
  model reply_model,
  thinking thinking_level,
  tier service_tier,
  PRIMARY KEY (guild_id, task)
);

INSERT INTO guild_ai_models (guild_id, task, model, thinking)
  SELECT id, 'reply', reply_model, reply_thinking FROM guilds
  WHERE reply_model IS NOT NULL OR reply_thinking IS NOT NULL;
