-- Servers whose members have no mention token limits (%tokenlimit unlimited on): no five-hour or
-- weekly limit, no slowing down to Flex, no daily cap for the server. Use is still counted.
ALTER TABLE guilds ADD COLUMN token_unlimited BOOLEAN NOT NULL DEFAULT false;
