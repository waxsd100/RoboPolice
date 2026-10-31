-- The model sometimes wrote how long its text was ("（45文字）") into summaries, emoji descriptions
-- and wiki knowledge. Those counts are taken out of what is stored (textClean.js does the same for
-- new text). Emoji descriptions are made again anyway (emojiDescriber.js, DESCRIBE_VERSION).
UPDATE youtube_summaries SET summary = regexp_replace(summary, '[ \t　]*[（(][[:space:]]*(約|全)?[[:space:]]*[0-9０-９][0-9０-９,，]*[[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]', '', 'g')
  WHERE summary ~ '[0-9０-９][[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]';
UPDATE guild_emojis SET description = regexp_replace(description, '[ \t　]*[（(][[:space:]]*(約|全)?[[:space:]]*[0-9０-９][0-9０-９,，]*[[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]', '', 'g')
  WHERE description ~ '[0-9０-９][[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]';
UPDATE wiki_facts SET content = regexp_replace(content, '[ \t　]*[（(][[:space:]]*(約|全)?[[:space:]]*[0-9０-９][0-9０-９,，]*[[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]', '', 'g')
  WHERE content ~ '[0-9０-９][[:space:]]*(文字|字)(以内|程度|前後)?[[:space:]]*[)）]';
