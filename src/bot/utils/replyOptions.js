// What a server can choose for its AI tasks, the same lists as the database's enum types
// (migrations/038_reply_enums.sql, 040_guild_ai_models.sql): adding a value here needs
// `ALTER TYPE … ADD VALUE` in a migration too (test/db/migrations.test.js checks they agree).

// The models a task can be run with (%replymodel): text models with a price in geminiPrices.js.
const REPLY_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite' // no thinking levels: it thinks as it is set (thinkingConfig is left out)
])

// How much Gemini 3 thinks before answering (%replymodel thinking, GEMINI_*_THINKING_LEVEL).
const THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high'])

// Inference tier (%replymodel tier): standard (immediate) or flex (half price, queued).
const SERVICE_TIERS = Object.freeze(['standard', 'flex'])

// Per-server configurable AI tasks (%replymodel <task> ...).
const AI_TASKS = Object.freeze(['reply', 'rules', 'blurb', 'light', 'extract', 'summary'])

const AI_TASK_LABELS = Object.freeze({
  reply: 'メンション返信・下書き作成',
  rules: '初回メンション時のルール選定',
  blurb: '配信開始前のイベント告知文・ゲームURL',
  light: '絵文字説明・定期Web検索',
  extract: 'Wiki / X / Steam / Web 知識抽出・内輪ネタ抽出',
  summary: '配信アーカイブ自動要約'
})

// How long replies are (/replylength).
const REPLY_LENGTH_CHOICES = Object.freeze(['long', 'normal', 'short'])

module.exports = { REPLY_MODELS, THINKING_LEVELS, SERVICE_TIERS, AI_TASKS, AI_TASK_LABELS, REPLY_LENGTH_CHOICES }
