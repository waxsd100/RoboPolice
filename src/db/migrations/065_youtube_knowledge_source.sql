-- Allow YouTube videos of the bot's followed channels (youtubeKnowledge.js) as a first-class
-- source in the unified community knowledge tables alongside wiki, x, discord, and web.
ALTER TABLE knowledge_pages
  DROP CONSTRAINT knowledge_pages_source_check,
  ADD CONSTRAINT knowledge_pages_source_check
    CHECK (source IN ('wiki', 'x', 'discord', 'web', 'youtube'));

COMMENT ON TABLE knowledge_pages IS 'Wiki・X・Discord発言・Web検索・YouTube動画から収集された知識ページのメタデータ';
COMMENT ON COLUMN knowledge_pages.source IS '知識ソースの種別（wiki / x / discord / web / youtube）';
COMMENT ON VIEW v_knowledge_sections IS 'Wiki・X・Discord・Web・YouTube動画から取得した知識セクション一覧（ページタイトル・ファクト件数付き、ベクトル列除外）';
COMMENT ON COLUMN v_knowledge_sections.source IS '知識ソース種別（wiki / x / discord / web / youtube）';
COMMENT ON COLUMN v_knowledge_facts.source IS '知識ソース種別（wiki / x / discord / web / youtube）';
