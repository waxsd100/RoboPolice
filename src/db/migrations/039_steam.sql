-- The Steam accounts the bot follows (STEAM_ACCOUNTS, the same for every server): their profile,
-- owned/played games, reviews and wishlist, so the mention assistant knows what games the streamer
-- has played, how long, and what they wrote about them (search_steam).
CREATE TABLE steam_profiles (
  steam_id TEXT PRIMARY KEY,
  account_ref TEXT NOT NULL UNIQUE,
  persona_name TEXT,
  custom_url TEXT,
  summary TEXT,
  member_since TEXT,
  level INTEGER,
  game_count INTEGER,
  wishlist_count INTEGER,
  synced_at TIMESTAMPTZ
);

CREATE TABLE steam_apps (
  app_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT
);

CREATE TABLE steam_games (
  steam_id TEXT NOT NULL REFERENCES steam_profiles (steam_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  playtime_hours REAL,
  recent_hours REAL,
  first_played_at TIMESTAMPTZ,
  last_played_at TIMESTAMPTZ,
  PRIMARY KEY (steam_id, app_id)
);
CREATE INDEX steam_games_playtime ON steam_games (steam_id, playtime_hours DESC NULLS LAST);

CREATE TABLE steam_reviews (
  steam_id TEXT NOT NULL REFERENCES steam_profiles (steam_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL,
  name TEXT,
  recommended BOOLEAN NOT NULL,
  hours_on_record REAL,
  posted TEXT,
  content TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (steam_id, app_id)
);

CREATE TABLE steam_wishlist (
  steam_id TEXT NOT NULL REFERENCES steam_profiles (steam_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  priority INTEGER,
  added_at TIMESTAMPTZ,
  PRIMARY KEY (steam_id, app_id)
);
