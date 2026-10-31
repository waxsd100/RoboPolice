-- Posts of the streamer's X (Twitter) accounts (TWITTER_ACCOUNTS), read through FxTwitter by
-- twitterKnowledge.js. Each month's posts are also written as a page of the knowledge tables
-- (wiki_pages, wiki_sections), so knowledge is taken out of them and they are searched like the
-- wiki; this table is what those pages are made from.
CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  reply_to TEXT,
  media_urls TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX social_posts_account_created ON social_posts (account, created_at DESC);
