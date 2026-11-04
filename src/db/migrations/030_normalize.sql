-- Tidying the schema to third normal form: no lists in a column, nothing stored twice, every ID
-- that names a row of ours a foreign key, and an index under every foreign key.
--
-- Discord's own IDs (channels, users, roles) and YouTube's video IDs in summaries have no table of
-- ours to refer to, and stay plain. messages keeps guild_id beside channel_id: it is what search
-- and retention filter by in a table of millions of rows, and dropping it would only move the work
-- to a join on every search.

-- 1. The four sets of knowledge tables (wiki_, x_, discord_, web_), alike to the column, become one
--    set with the source as part of the key. Their image and alias lists become rows.
CREATE TABLE knowledge_pages (
  source TEXT NOT NULL CHECK (source IN ('wiki', 'x', 'discord', 'web')),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, url)
);
CREATE TABLE knowledge_sections (
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  facts_hash TEXT,
  PRIMARY KEY (source, url, position),
  FOREIGN KEY (source, url) REFERENCES knowledge_pages (source, url) ON DELETE CASCADE
);
CREATE INDEX knowledge_sections_model ON knowledge_sections (model_id);
CREATE TABLE knowledge_section_images (
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  image_position SMALLINT NOT NULL,
  image_url TEXT NOT NULL,
  PRIMARY KEY (source, url, position, image_position),
  FOREIGN KEY (source, url, position) REFERENCES knowledge_sections (source, url, position) ON DELETE CASCADE
);
CREATE TABLE knowledge_facts (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'quote', 'term')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (source, url, position) REFERENCES knowledge_sections (source, url, position) ON DELETE CASCADE
);
CREATE INDEX knowledge_facts_section ON knowledge_facts (source, url, position);
CREATE INDEX knowledge_facts_kind ON knowledge_facts (source, kind);
CREATE INDEX knowledge_facts_model ON knowledge_facts (model_id);
CREATE TABLE knowledge_fact_aliases (
  fact_id BIGINT NOT NULL REFERENCES knowledge_facts (id) ON DELETE CASCADE,
  alias_position SMALLINT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (fact_id, alias_position)
);

ALTER TABLE knowledge_facts ADD COLUMN old_id BIGINT;
DO $$
DECLARE src TEXT;
BEGIN
  FOREACH src IN ARRAY ARRAY['wiki', 'x', 'discord', 'web'] LOOP
    EXECUTE format('INSERT INTO knowledge_pages (source, url, title, fetched_at) SELECT %L, url, title, fetched_at FROM %I', src, src || '_pages');
    EXECUTE format('INSERT INTO knowledge_sections (source, url, position, heading, text, text_hash, embedding, model_id, facts_hash)
      SELECT %L, url, position, heading, text, text_hash, embedding, model_id, facts_hash FROM %I', src, src || '_sections');
    EXECUTE format('INSERT INTO knowledge_section_images (source, url, position, image_position, image_url)
      SELECT %L, s.url, s.position, i.n - 1, i.image FROM %I s CROSS JOIN LATERAL unnest(s.images) WITH ORDINALITY AS i (image, n)
      WHERE i.image IS NOT NULL AND i.image <> %L', src, src || '_sections', '');
    EXECUTE format('INSERT INTO knowledge_facts (source, url, position, kind, name, content, embedding, model_id, old_id)
      SELECT %L, url, position, kind, name, content, embedding, model_id, id FROM %I ORDER BY id', src, src || '_facts');
    EXECUTE format('INSERT INTO knowledge_fact_aliases (fact_id, alias_position, alias)
      SELECT k.id, a.n - 1, a.alias FROM %I f JOIN knowledge_facts k ON k.source = %L AND k.old_id = f.id
      CROSS JOIN LATERAL unnest(f.aliases) WITH ORDINALITY AS a (alias, n)
      WHERE a.alias IS NOT NULL AND a.alias <> %L', src || '_facts', src, '');
    EXECUTE format('DROP TABLE %I, %I, %I', src || '_facts', src || '_sections', src || '_pages');
  END LOOP;
END $$;
ALTER TABLE knowledge_facts DROP COLUMN old_id;

-- 2. An X post's media URLs become rows. Its knowledge pages are in knowledge_pages above.
CREATE TABLE x_post_media (
  post_id TEXT NOT NULL REFERENCES x_posts (id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (post_id, position)
);
INSERT INTO x_post_media (post_id, position, url)
  SELECT p.id, m.n - 1, m.url FROM x_posts p CROSS JOIN LATERAL unnest(p.media_urls) WITH ORDINALITY AS m (url, n)
  WHERE m.url IS NOT NULL AND m.url <> '';
ALTER TABLE x_posts DROP COLUMN media_urls;

-- 3. A Discord knowledge post kept its channel's and author's names on every row (they depend on
--    the channel and the author, not on the post) and its server beside its channel. Names are
--    kept once each; the server is the channel's.
CREATE TABLE discord_channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE INDEX discord_channels_guild ON discord_channels (guild_id);
CREATE TABLE discord_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO discord_channels (id, guild_id, name)
  SELECT DISTINCT ON (channel_id) channel_id, guild_id, channel_name FROM discord_posts ORDER BY channel_id, created_at DESC;
INSERT INTO discord_users (id, name)
  SELECT DISTINCT ON (author_id) author_id, author_name FROM discord_posts ORDER BY author_id, created_at DESC;
DROP INDEX discord_posts_author_created;
ALTER TABLE discord_posts
  DROP COLUMN guild_id,
  DROP COLUMN channel_name,
  DROP COLUMN author_name,
  ADD CONSTRAINT discord_posts_channel_fkey FOREIGN KEY (channel_id) REFERENCES discord_channels (id) ON DELETE CASCADE,
  ADD CONSTRAINT discord_posts_author_fkey FOREIGN KEY (author_id) REFERENCES discord_users (id) ON DELETE CASCADE;
CREATE INDEX discord_posts_author_created ON discord_posts (author_id, created_at);
CREATE INDEX discord_posts_channel ON discord_posts (channel_id);

-- 4. The videos of a summary batch become rows (the order is kept for the report).
CREATE TABLE youtube_summary_batch_videos (
  batch_name TEXT NOT NULL REFERENCES youtube_summary_batches (name) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  video_id TEXT NOT NULL,
  PRIMARY KEY (batch_name, position)
);
INSERT INTO youtube_summary_batch_videos (batch_name, position, video_id)
  SELECT b.name, v.n - 1, v.video_id FROM youtube_summary_batches b CROSS JOIN LATERAL unnest(b.video_ids) WITH ORDINALITY AS v (video_id, n);
ALTER TABLE youtube_summary_batches DROP COLUMN video_ids;
CREATE INDEX youtube_summary_batches_guild ON youtube_summary_batches (guild_id);

-- 5. An embedding batch names its model by ID like everything else, and its messages refer to
--    their rows (a message deleted meanwhile leaves the batch).
ALTER TABLE embedding_batches ADD COLUMN model_id SMALLINT REFERENCES embedding_models (id);
INSERT INTO embedding_models (name) SELECT DISTINCT model FROM embedding_batches ON CONFLICT (name) DO NOTHING;
UPDATE embedding_batches b SET model_id = m.id FROM embedding_models m WHERE m.name = b.model;
ALTER TABLE embedding_batches ALTER COLUMN model_id SET NOT NULL, DROP COLUMN model;
CREATE INDEX embedding_batches_model ON embedding_batches (model_id);
DELETE FROM embedding_batch_messages b WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = b.message_id);
ALTER TABLE embedding_batch_messages ADD CONSTRAINT embedding_batch_messages_message_fkey
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE;
CREATE INDEX embedding_batch_messages_batch ON embedding_batch_messages (batch_name);

-- 6. Indexes under foreign keys that had none (small tables; messages.embedding_model_id is left:
--    an index over every message would cost far more than it saves, as models are never deleted).
CREATE INDEX youtube_videos_embedding_model ON youtube_videos (embedding_model_id);
CREATE INDEX guild_emojis_model ON guild_emojis (model_id);
CREATE INDEX guild_lore_facts_model ON guild_lore_facts (model_id);
CREATE INDEX message_backfill_guild ON message_backfill (guild_id);
CREATE INDEX discord_backfill_guild ON discord_backfill (guild_id);
