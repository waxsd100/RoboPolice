-- Drop the external uncensored LLM handover setting from guilds now that external / Railway LLM
-- endpoints (UNCENSORED_API_URL / UNCENSORED_GATEWAY_PROVIDER) have been removed.
ALTER TABLE guilds
  DROP COLUMN IF EXISTS uncensored_r18;
