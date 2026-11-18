-- Synthesized speaking-style profile, curated everyday utterances, and 2-turn dialogue pairs of
-- the streamer (src/bot/modules/streamerStyle.js). Persisted in Postgres so restarts, Redis
-- outages, and non-shard-0 workers immediately have the profile without waiting for another pass.
CREATE TABLE streamer_style (
  key            TEXT PRIMARY KEY,
  profile        TEXT NOT NULL,
  quantitative   TEXT NOT NULL DEFAULT '',
  exemplars      JSONB NOT NULL DEFAULT '[]'::jsonb,
  dialogue_pairs JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_hash    TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE streamer_style IS '配信者本人の発言コーパスから抽出した話し方プロファイルと発言・会話ペア見本の永続保存（再起動・Redis停止・マルチワーカー間共有用）';
COMMENT ON COLUMN streamer_style.key IS 'プロファイルの識別キー（通常は default）';
COMMENT ON COLUMN streamer_style.profile IS 'AI が抽出・反復改善した話し方・文体プロファイル本文';
COMMENT ON COLUMN streamer_style.quantitative IS '文長・句読点・笑い表現などの定量スタイル統計';
COMMENT ON COLUMN streamer_style.exemplars IS '普段の発言例（MMR 選定済みの文字列配列 JSON）';
COMMENT ON COLUMN streamer_style.dialogue_pairs IS '2ターン会話ペア見本（[{ partner, reply }] の JSON 配列）';
COMMENT ON COLUMN streamer_style.source_hash IS '抽出元プロンプトとコーパスのハッシュ（変更検知用）';
COMMENT ON COLUMN streamer_style.updated_at IS '最終更新日時';
