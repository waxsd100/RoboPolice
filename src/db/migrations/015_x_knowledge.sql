-- The X posts get tables of their own instead of sharing the wiki's. Their monthly pages were
-- written into wiki_pages / wiki_sections / wiki_facts (as https://x.com/<account>#<month>); they
-- move, with their embeddings and the knowledge taken out of them, to x_pages / x_sections /
-- x_facts, which have the same shape. social_posts becomes x_posts.
CREATE TABLE x_pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE x_sections (
  url TEXT NOT NULL REFERENCES x_pages (url) ON DELETE CASCADE,
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

CREATE TABLE x_facts (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'quote', 'term')),
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (url, position) REFERENCES x_sections (url, position) ON DELETE CASCADE
);
CREATE INDEX x_facts_section ON x_facts (url, position);
CREATE INDEX x_facts_kind ON x_facts (kind);

INSERT INTO x_pages (url, title, fetched_at)
  SELECT url, title, fetched_at FROM wiki_pages WHERE url LIKE 'https://x.com/%';
INSERT INTO x_sections (url, position, heading, text, images, text_hash, embedding, model_id, facts_hash)
  SELECT url, position, heading, text, images, text_hash, embedding, model_id, facts_hash
  FROM wiki_sections WHERE url LIKE 'https://x.com/%';
INSERT INTO x_facts (url, position, kind, name, aliases, content, embedding, model_id)
  SELECT url, position, kind, name, aliases, content, embedding, model_id
  FROM wiki_facts WHERE url LIKE 'https://x.com/%' ORDER BY id;
-- Their sections and knowledge go with them.
DELETE FROM wiki_pages WHERE url LIKE 'https://x.com/%';

ALTER TABLE social_posts RENAME TO x_posts;
ALTER INDEX social_posts_pkey RENAME TO x_posts_pkey;
ALTER INDEX social_posts_account_created RENAME TO x_posts_account_created;
