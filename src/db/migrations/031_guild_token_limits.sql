-- Each server's own mention token limits (%tokenlimit): per user in five hours and in a week, and
-- the share of either at which the user's mentions go to Flex inference. NULL is the default
-- (MENTION_TOKEN_LIMIT_5H, MENTION_TOKEN_LIMIT_WEEK, MENTION_FLEX_AT_PERCENT); 0 turns one off.
ALTER TABLE guilds
  ADD COLUMN token_limit_5h INTEGER CHECK (token_limit_5h >= 0),
  ADD COLUMN token_limit_week INTEGER CHECK (token_limit_week >= 0),
  ADD COLUMN token_flex_at SMALLINT CHECK (token_flex_at BETWEEN 0 AND 100);
