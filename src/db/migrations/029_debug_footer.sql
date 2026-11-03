-- Whether mention replies in the server end with the debug line (the models that answered, the
-- Gemini tokens they used and what fell back): off by default, turned on with %debugfooter.
ALTER TABLE guilds ADD COLUMN debug_footer BOOLEAN NOT NULL DEFAULT false;
