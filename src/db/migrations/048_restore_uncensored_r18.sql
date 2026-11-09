-- Restore per-guild R18 / uncensored LLM handover setting for Cloud Run GPU (UNCENSORED_API_URL).
ALTER TABLE guilds
  ADD COLUMN IF NOT EXISTS uncensored_r18 BOOLEAN;

COMMENT ON COLUMN guilds.uncensored_r18 IS 'R18・検閲ブロック時に検閲なしモデル（UNCENSORED_MODEL）へ引き継ぐか（NULLは既定値：オーナーサーバーのみON、それ以外はOFF）';

UPDATE guilds
  SET uncensored_r18 = TRUE
  WHERE safety_filter = FALSE AND uncensored_r18 IS NULL;
