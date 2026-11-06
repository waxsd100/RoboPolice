-- What a server's moderators ask the mention assistant to keep to (/assistantrules): topics to
-- avoid, words not to use, how to treat spoilers... NULL for none. The server's rules channel is
-- read as well (serverRules.js); this is for what is not in it, or only for the assistant.
ALTER TABLE guilds ADD COLUMN assistant_rules TEXT CHECK (char_length(assistant_rules) <= 2000);
