-- Pages of the community wiki (WIKI_URLS), read by wikiKnowledge.js: each page, split at its
-- headings, with the images of each part and an embedding, so the mention assistant can search
-- it by meaning (search_wiki) and emojis can be matched to the characters it describes.
CREATE TABLE wiki_pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wiki_sections (
  url TEXT NOT NULL REFERENCES wiki_pages (url) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  images TEXT[] NOT NULL DEFAULT '{}',
  -- Of heading and text: a part that did not change keeps its embedding.
  text_hash TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  -- text_hash when its knowledge was last taken out (wiki_facts): a changed part is read again.
  facts_hash TEXT,
  PRIMARY KEY (url, position)
);

-- What Gemini took out of each part as knowledge: a character (who it is, other names, how it
-- looks), a quote (the words and where they come from) or a term (a running joke, a word the
-- community uses, and what it means), each embedded on its own.
CREATE TABLE wiki_facts (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'quote', 'term')),
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  embedding halfvec(512),
  model_id SMALLINT REFERENCES embedding_models (id),
  FOREIGN KEY (url, position) REFERENCES wiki_sections (url, position) ON DELETE CASCADE
);
CREATE INDEX wiki_facts_section ON wiki_facts (url, position);
CREATE INDEX wiki_facts_kind ON wiki_facts (kind);

-- What the wiki said about the characters when an emoji was described: when that changes, the
-- emojis are described again.
ALTER TABLE guild_emojis ADD COLUMN context_hash TEXT;
