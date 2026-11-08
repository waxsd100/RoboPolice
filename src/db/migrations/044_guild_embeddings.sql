-- Per-server toggles for vectorizing messages (embeddingIndexer.js) and describing/vectorizing
-- custom emojis (emojiDescriber.js), configured with %embeddings. NULL uses the default (enabled
-- only in OWNER_GUILD_IDS).
ALTER TABLE guilds
  ADD COLUMN embed_messages BOOLEAN,
  ADD COLUMN embed_emojis BOOLEAN;

COMMENT ON COLUMN guilds.embed_messages IS 'このサーバーのメッセージをベクトル埋め込み（意味検索用）の対象にするかどうか（NULLは既定値：オーナーサーバーのみON）';
COMMENT ON COLUMN guilds.embed_emojis IS 'このサーバーのカスタム絵文字をAI説明文生成・ベクトル埋め込みの対象にするかどうか（NULLは既定値：オーナーサーバーのみON）';

-- Once: write out the defaults for existing servers (owner guild = true, others = false) so they
-- can be read and changed directly in the table. A server added later starts at NULL again.
UPDATE guilds SET
  embed_messages = coalesce(embed_messages, id = '615170683068219393'),
  embed_emojis = coalesce(embed_emojis, id = '615170683068219393')
WHERE embed_messages IS NULL OR embed_emojis IS NULL;
