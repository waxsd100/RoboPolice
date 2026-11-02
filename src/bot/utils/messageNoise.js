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

// The text of a message as it is embedded, or '' for one not worth embedding.
function embeddableText (text) {
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

module.exports = { embeddableText, minChars, DEFAULT_MIN_CHARS }
