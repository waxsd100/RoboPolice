-- A server's settings were a JSON object (event -> log channel, '' for none) and arrays in the
-- guilds row. Each becomes a table of its own, one row per setting, removed with the server.

CREATE TABLE guild_event_logs (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, event)
);
CREATE INDEX guild_event_logs_channel ON guild_event_logs (guild_id, channel_id);
INSERT INTO guild_event_logs (guild_id, event, channel_id)
  SELECT g.id, e.key, e.value
  FROM guilds g CROSS JOIN LATERAL json_each_text(COALESCE(g.event_logs, '{}'::json)) e
  WHERE json_typeof(COALESCE(g.event_logs, '{}'::json)) = 'object' AND COALESCE(e.value, '') <> '';

CREATE TABLE guild_ignored_channels (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
INSERT INTO guild_ignored_channels (guild_id, channel_id)
  SELECT DISTINCT g.id, c FROM guilds g CROSS JOIN LATERAL unnest(COALESCE(g.ignored_channels, '{}')) c
  WHERE COALESCE(c, '') <> '';

CREATE TABLE guild_disabled_events (
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  PRIMARY KEY (guild_id, event)
);
INSERT INTO guild_disabled_events (guild_id, event)
  SELECT DISTINCT g.id, e FROM guilds g CROSS JOIN LATERAL unnest(COALESCE(g.disabled_events, '{}')) e
  WHERE COALESCE(e, '') <> '';

-- custom_settings was always {} and nothing read it.
ALTER TABLE guilds
  DROP COLUMN event_logs,
  DROP COLUMN ignored_channels,
  DROP COLUMN disabled_events,
  DROP COLUMN custom_settings;
UPDATE guilds SET log_bots = false WHERE log_bots IS NULL;
ALTER TABLE guilds ALTER COLUMN log_bots SET DEFAULT false, ALTER COLUMN log_bots SET NOT NULL;
