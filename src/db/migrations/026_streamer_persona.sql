-- Whether the mention assistant speaks as the streamer of the server's YouTube channel (/persona):
-- true (the default, as until now) or false, as the server's bot, which talks about the streamer
-- without being them.
ALTER TABLE guilds ADD COLUMN streamer_persona BOOLEAN NOT NULL DEFAULT true;
