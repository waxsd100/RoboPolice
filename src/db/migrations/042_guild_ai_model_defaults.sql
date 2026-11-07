-- Once: every server's AI task settings that were left at the default (missing or NULL) are written
-- out as the default they stood for, so all 6 tasks can be read and edited directly in the table.
-- A server added later starts at NULL again (the default, whatever it is then).
UPDATE guilds SET
  reply_model = coalesce(reply_model, 'gemini-3.8-flash'),
  reply_thinking = coalesce(reply_thinking, 'high')
WHERE reply_model IS NULL OR reply_thinking IS NULL;

INSERT INTO guild_ai_models (guild_id, task, model, thinking, tier)
SELECT g.id, d.task::ai_task, d.model::reply_model, d.thinking::thinking_level, d.tier::service_tier
FROM guilds g
CROSS JOIN (VALUES
  ('reply',   'gemini-3.8-flash',      'high',    'standard'),
  ('rules',   'gemini-3.1-flash-lite', 'minimal', 'standard'),
  ('blurb',   'gemini-3.5-flash-lite', 'low',     'standard'),
  ('light',   'gemini-3.5-flash-lite', 'low',     'flex'),
  ('extract', 'gemini-3.1-flash-lite', 'minimal', 'flex'),
  ('summary', 'gemini-3.8-flash',      'low',     'flex')
) AS d (task, model, thinking, tier)
ON CONFLICT (guild_id, task) DO UPDATE SET
  model = coalesce(guild_ai_models.model, EXCLUDED.model),
  thinking = coalesce(guild_ai_models.thinking, EXCLUDED.thinking),
  tier = coalesce(guild_ai_models.tier, EXCLUDED.tier);
