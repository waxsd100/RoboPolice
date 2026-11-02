-- How long the mention assistant's replies are in each server (/replylength): long (up to about 500
-- characters, as before replies were fitted to what was said), normal (fitted to what was said) or
-- short. NULL is long.
ALTER TABLE guilds ADD COLUMN reply_length TEXT CHECK (reply_length IN ('long', 'normal', 'short'));
