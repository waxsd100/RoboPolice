-- Where each running Batch API job stands, to see from the database: Gemini's state when last
-- looked at (BATCH_STATE_RUNNING, …), when that was, and the error of the last look that failed.
-- A batch is given up on (and its work sent again) once it is older than Gemini keeps one.
ALTER TABLE embedding_batches
  ADD COLUMN state TEXT,
  ADD COLUMN checked_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT;
ALTER TABLE youtube_summary_batches
  ADD COLUMN state TEXT,
  ADD COLUMN checked_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT;
