-- Past messages are embedded through Gemini's Batch API (half the price, done within a day):
-- a row per batch still running, and the messages in it, so they are not sent again meanwhile
-- and a restart goes on watching it. Dropped when the batch is done.
CREATE TABLE embedding_batches (
  name TEXT PRIMARY KEY, -- Gemini's batches/…
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE embedding_batch_messages (
  message_id TEXT PRIMARY KEY,
  batch_name TEXT NOT NULL REFERENCES embedding_batches (name) ON DELETE CASCADE
);
