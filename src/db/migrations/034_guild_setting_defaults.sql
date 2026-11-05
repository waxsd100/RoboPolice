-- Once: every server's mention settings that were left at the default (NULL) are written out as
-- the default they stood for, so they can be read and changed in the table. A server added later
-- starts at NULL again (the default, whatever it is then).
UPDATE guilds SET
  reply_length = coalesce(reply_length, 'long'),
  token_limit_5h = coalesce(token_limit_5h, 150000),
  token_limit_week = coalesce(token_limit_week, 750000),
  token_flex_at = coalesce(token_flex_at, 80)
WHERE reply_length IS NULL OR token_limit_5h IS NULL OR token_limit_week IS NULL OR token_flex_at IS NULL;
