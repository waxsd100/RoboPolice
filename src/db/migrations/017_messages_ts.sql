-- The hourly prune (src/miscellaneous/prune.js) deletes messages older than MESSAGE_HISTORY_DAYS by
-- their time alone. The indexes on ts lead with the server or the channel, so each batch read the
-- whole table; this one lets it find the oldest messages directly.
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
