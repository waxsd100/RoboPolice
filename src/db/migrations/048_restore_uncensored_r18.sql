-- Restore per-guild R18 / uncensored LLM handover setting for Cloud Run GPU (UNCENSORED_API_URL).
ALTER TABLE guilds
  ADD COLUMN IF NOT EXISTS uncensored_r18 BOOLEAN;

UPDATE guilds
  SET uncensored_r18 = TRUE
  WHERE safety_filter = FALSE AND uncensored_r18 IS NULL;
