-- Partial index to speed up cross-server BAN checks across all guilds the bot is in.
CREATE INDEX IF NOT EXISTS member_activity_profiles_user_banned
  ON member_activity_profiles (user_id)
  WHERE status = 'banned';
