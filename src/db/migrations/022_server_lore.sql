-- What a server is like, for the mention assistant (serverLore.js): its running jokes, words and
-- happenings, taken by Gemini out of the messages already stored for its logs, in channels everyone
-- (@everyone) can read, one chunk per channel and week; and how its members talk (the style). Only
-- the last SERVER_LORE_WEEKS weeks: older chunks go, and a chunk whose messages changed (edited,
-- deleted, /clearmydata) is taken out again. Nothing about a single member is kept: members are
-- looked up only when asked about, at that moment.
CREATE TABLE guild_lore_chunks (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  -- The Monday (Asia/Tokyo) the week starts
  week DATE NOT NULL,
  text_hash TEXT NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id, week)
);

CREATE TABLE guild_lore_facts (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  week DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('joke', 'term', 'event', 'topic')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (guild_id, channel_id, week) REFERENCES guild_lore_chunks (guild_id, channel_id, week) ON DELETE CASCADE
);
CREATE INDEX guild_lore_facts_chunk ON guild_lore_facts (guild_id, channel_id, week);

CREATE TABLE guild_lore_style (
  guild_id TEXT PRIMARY KEY REFERENCES guilds (id) ON DELETE CASCADE,
  style TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
