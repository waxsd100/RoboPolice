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
  PRIMARY KEY (url, position)
);

-- What the wiki said about the characters when an emoji was described: when that changes, the
-- emojis are described again.
ALTER TABLE guild_emojis ADD COLUMN context_hash TEXT;
