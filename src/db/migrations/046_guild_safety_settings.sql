-- Per-server toggles for Gemini safety filtering (eventDrafter.js) and R18 / uncensored model
-- handover (UNCENSORED_MODEL), configured with %safety. NULL uses the default (owner servers:
-- safety_filter = false, uncensored_r18 = true; all other servers: safety_filter = true,
-- uncensored_r18 = false).
ALTER TABLE guilds
  ADD COLUMN safety_filter BOOLEAN,
  ADD COLUMN uncensored_r18 BOOLEAN;

COMMENT ON COLUMN guilds.safety_filter IS 'Geminiのセーフティフィルタ（危険・アダルト等のブロック）を有効にするか（NULLは既定値：オーナーサーバー以外はON、オーナーサーバーはOFF）';
COMMENT ON COLUMN guilds.uncensored_r18 IS 'R18・検閲ブロック時に検閲なしモデル（UNCENSORED_MODEL）へ引き継ぐか（NULLは既定値：オーナーサーバーのみON、それ以外はOFF）';

-- Once: write out the defaults for existing servers (owner guild = filter false / uncensored true,
-- others = filter true / uncensored false) so they can be read and changed directly in the table.
-- A server added later starts at NULL again.
UPDATE guilds SET
  safety_filter = coalesce(safety_filter, id <> '615170683068219393'),
  uncensored_r18 = coalesce(uncensored_r18, id = '615170683068219393')
WHERE safety_filter IS NULL OR uncensored_r18 IS NULL;
