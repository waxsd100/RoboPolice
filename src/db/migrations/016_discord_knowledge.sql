-- The streamer's own Discord messages as knowledge (discordKnowledge.js): only in the owner's
-- servers, only in channels everyone (@everyone) can read, only by the accounts named in
-- DISCORD_KNOWLEDGE_USERS. Like the X posts: each message in discord_posts, and each account's
-- messages of a month written as a page of discord_pages / discord_sections / discord_facts (the
-- same shape as the wiki's tables) to take knowledge out of and search by meaning.
CREATE TABLE discord_posts (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX discord_posts_author_created ON discord_posts (guild_id, author_id, created_at);

-- How far back each channel's history has been read: the oldest message read so far, and whether
-- the start of the channel was reached.
CREATE TABLE discord_backfill (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  before_id TEXT,
  done BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE discord_pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE discord_sections (
  url TEXT NOT NULL REFERENCES discord_pages (url) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  images TEXT[] NOT NULL DEFAULT '{}',
  text_hash TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  facts_hash TEXT,
  PRIMARY KEY (url, position)
);

CREATE TABLE discord_facts (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'quote', 'term')),
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (url, position) REFERENCES discord_sections (url, position) ON DELETE CASCADE
);
CREATE INDEX discord_facts_section ON discord_facts (url, position);
CREATE INDEX discord_facts_kind ON discord_facts (kind);
