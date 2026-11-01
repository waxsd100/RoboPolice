-- Knowledge looked up on the web (webKnowledge.js): for each topic of KNOWLEDGE_TOPICS (e.g. the
-- groups the streamer belongs to), what Gemini found with Google Search, as a page of
-- web_pages / web_sections / web_facts (the same shape as the wiki's tables).
CREATE TABLE web_pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE web_sections (
  url TEXT NOT NULL REFERENCES web_pages (url) ON DELETE CASCADE,
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

CREATE TABLE web_facts (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'quote', 'term')),
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (url, position) REFERENCES web_sections (url, position) ON DELETE CASCADE
);
CREATE INDEX web_facts_section ON web_facts (url, position);
