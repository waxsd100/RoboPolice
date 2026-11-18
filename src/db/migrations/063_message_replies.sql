-- Which message a stored message replied to (Discord's message reference). Most messages are no
-- reply, so it is a row of its own, not a column left empty in most rows. Searching the server's
-- messages (semanticSearch.searchConversations) follows these to give a message found with the
-- conversation it was part of. Kept for messages stored from now on, and for those read from a
-- channel's history from now on.
CREATE TABLE message_replies (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  reply_to   TEXT NOT NULL
);
CREATE INDEX message_replies_reply_to ON message_replies (reply_to);

COMMENT ON TABLE message_replies IS 'メッセージが返信だったときの返信先（返信でないメッセージには行がない）。サーバーのメッセージ検索で、見つかった発言を会話ごと渡すのに使う';
COMMENT ON COLUMN message_replies.message_id IS '返信したメッセージのID（messages.id）';
COMMENT ON COLUMN message_replies.reply_to IS '返信先のメッセージのID（保存していないメッセージのこともある）';
