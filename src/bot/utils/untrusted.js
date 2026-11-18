// Text the bot did not write (messages, web pages, stored knowledge) given to Gemini: marked off as
// data so instructions in it are not taken as the bot's own (prompt injection), and checked for
// the usual tricks so attempts show up in the logs.

const TAG = 'untrusted'

// Breaking out of the tag by writing it: <untrusted and </untrusted inside the text are defused.
function defuse (text) {
  return String(text ?? '').replace(new RegExp(`<\\s*(/?)\\s*${TAG}`, 'gi'), (whole, slash) => `‹${slash}${TAG}`)
}

// `text` inside <untrusted source="…">…</untrusted>.
function wrap (source, text) {
  return `<${TAG} source="${String(source).replace(/[^\w:./-]/g, '')}">\n${defuse(text)}\n</${TAG}>`
}

// The usual wording of an attempt to take over the model. Matching is only logged (and keeps such
// text out of stored knowledge); nothing is refused on it alone.
const PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|system)/i,
  /(reveal|print|show|repeat)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /\b(system|developer)\s+(prompt|message|mode)\b/i,
  /\bjail\s?break\b/i,
  /you\s+are\s+now\s+(a|an|in)\b/i,
  /(これまで|以前|上記|前)の(指示|命令|設定|ルール)を(すべて|全部|全て)?(無視|忘れ|破棄)/,
  /(指示|命令|設定|ルール)を(すべて|全部|全て)?(無視|忘れ)(て|して|ろ|しろ|せよ|なさい)/,
  /システム\s*プロンプト|システム\s*メッセージ|開発者モード|プロンプトインジェクション/,
  /(あなた|お前|君|BOT|ボット)は今から/i,
  /(BOT|ボット|AI)は(今後|これから)(必ず|常に|ずっと)?.{0,30}(と言え|と言って|と答えろ|と答えて|しろ|せよ)/i
]

function looksLikeInjection (text) {
  const s = String(text || '')
  return PATTERNS.some(p => p.test(s))
}

// Logs (once per call) where an injection attempt was seen.
function reportInjection (where, text) {
  if (!looksLikeInjection(text)) return false
  global.logger?.warn(`[INJECTION]: Possible prompt injection in ${where}: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
  return true
}

module.exports = { wrap, defuse, looksLikeInjection, reportInjection, TAG }
