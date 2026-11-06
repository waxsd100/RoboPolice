// What a server can choose for its mention replies, the same lists as the database's enum types
// (migrations/038_reply_enums.sql): adding a value here needs `ALTER TYPE … ADD VALUE` in a
// migration too (test/db/migrations.test.js checks they agree).

// The models a reply can be written with (%replymodel): text models with a price in geminiPrices.js.
const REPLY_MODELS = Object.freeze(['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])

// How much Gemini 3 thinks before answering (%replymodel thinking, GEMINI_*_THINKING_LEVEL).
const THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high'])

// How long replies are (/replylength).
const REPLY_LENGTH_CHOICES = Object.freeze(['long', 'normal', 'short'])

module.exports = { REPLY_MODELS, THINKING_LEVELS, REPLY_LENGTH_CHOICES }
