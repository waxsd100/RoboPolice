// Which messages are worth embedding, and the part of them that is: a chat is full of "w", "草",
// stickers, a bare link or a mention, which say nothing to search by meaning and only crowd out
// what does (and cost an embedding each). Links, emojis, mentions and timestamps are taken out of
// the text; what is left must have at least MESSAGE_EMBEDDING_MIN_CHARS letters or digits
// (default 5) and be more than laughter.
const DEFAULT_MIN_CHARS = 5

function minChars () {
  const n = Number(process.env.MESSAGE_EMBEDDING_MIN_CHARS)
  return process.env.MESSAGE_EMBEDDING_MIN_CHARS && Number.isInteger(n) && n >= 0 ? n : DEFAULT_MIN_CHARS
}

// Laughter and its like, whatever the length: www, ｗｗ, 草, 笑.
const LAUGHTER = /^[wWｗＷ草笑]+$/u

// A command to some bot: a prefix (! / % $ . ? or this bot's GLOBAL_BOT_PREFIX) right before a
// word, such as !rank, /roll, %help, .play 曲名, ?ban. Markdown is not: '> 引用', '- 項目' have a
// space after the mark, '~~消し~~' is not a prefix here, and '...' or '？' are not either.
const COMMAND_PREFIXES = '!/%$.?'
function isCommand (text) {
  const prefixes = [...COMMAND_PREFIXES, process.env.GLOBAL_BOT_PREFIX].filter(Boolean)
  const t = String(text || '').trim()
  return prefixes.some(p => t.startsWith(p) && /^[a-z][\w-]*/i.test(t.slice(p.length)))
}

// The text of a message as it is embedded, or '' for one not worth embedding.
function embeddableText (text) {
  // 'None' is how a message with no text (only images, a sticker or an embed) is stored.
  if (String(text || '').trim() === 'None') return ''
  // Commands to bots say nothing of the conversation.
  if (isCommand(text)) return ''
  const s = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ') // links
    .replace(/<a?:\w+:\d+>/g, ' ') // custom emojis
    .replace(/<(?:@[!&]?|#)\d+>/g, ' ') // mentions and channel links
    .replace(/<t:\d+(?::\w)?>/g, ' ') // timestamps
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, ' ') // emojis
    .replace(/(\D)\1{2,}/gu, '$1$1') // drawn-out letters (ーーーー, おおおお): two are enough
    .replace(/\s+/g, ' ')
    .trim()
  const meaningful = s.replace(/[^\p{L}\p{N}]/gu, '')
  if (!meaningful || LAUGHTER.test(meaningful) || [...meaningful].length < minChars()) return ''
  return s
}

module.exports = { embeddableText, isCommand, minChars, DEFAULT_MIN_CHARS }
