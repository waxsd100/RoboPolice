-- A server's custom emojis, with what each looks like and when to use it (made by Gemini from its
-- name and image), and that text's embedding, so the emojis that suit a conversation can be found.
-- Kept in step with Discord by emojiDescriber.js; an emoji goes with its server.
CREATE TABLE guild_emojis (
  emoji_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  animated BOOLEAN NOT NULL DEFAULT false,
  -- The name the description was made with: a renamed emoji is described again.
  described_name TEXT,
  description TEXT,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_emojis_guild ON guild_emojis (guild_id);
