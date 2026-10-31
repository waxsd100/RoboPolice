-- What a server is, for reading the table: its name, icon, member count and when the bot joined.
-- Refreshed by the bot (at startup, when the server changes, and hourly for the member count).
ALTER TABLE guilds
  ADD COLUMN name TEXT,
  ADD COLUMN icon_url TEXT,
  ADD COLUMN member_count INTEGER,
  ADD COLUMN joined_at TIMESTAMPTZ,
  ADD COLUMN details_updated_at TIMESTAMPTZ;
