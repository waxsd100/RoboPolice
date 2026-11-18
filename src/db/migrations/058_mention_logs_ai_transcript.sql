-- Everything sent to an AI model for a mention and what came back (aiTranscript.js), so why a
-- request was refused or answered as it was can be looked at afterwards.
ALTER TABLE mention_logs ADD COLUMN IF NOT EXISTS ai_transcript JSONB;

COMMENT ON COLUMN mention_logs.ai_transcript IS 'AI に送った内容と返ってきた内容のすべて（呼び出しごと）。{ systems: {ハッシュ: システム指示}, calls: [{ at, model, purpose, system, tools, safetySettings, generationConfig, fromTurn, turns（前の呼び出しからの差分）, response（finishReason・blockReason・safetyRatings・parts）, error }] }。画像は種類と大きさだけ、長い文は 20000 文字で省略';
