// Guards against child-safety / minor-related prompt poisoning when retrieving untrusted wiki,
// lore, and chat history, or assembling system instructions and tool declarations for Gemini.
//
// Google's CSAM / child-safety classifier (PROHIBITED_CONTENT) evaluates system instructions,
// tool descriptions, retrieved context, and the user's message together and cannot be turned off
// via safetySettings. A benign mention containing a word such as 「児童」 gets blocked when:
//   1. Wiki / lore / past-message retrieval pulls in community jokes or quotes combining minor
//      terms with sexual, abusive, or exploitative terms (or piles many disconnected minor-related
//      snippets into one prompt), or
//   2. Adult / sexual instructions (chat/mature/* or hand_over_r18) sit in the same request
//      payload alongside minor-related terms.

const MINOR_QUERY_TERM_RE = /(?:児童|女児|男児|小児|幼児|乳幼児|園児|未就学児|小学生|中学生|小中学生|未成年|18歳未満|幼女|女子小学生|女子中学生|児ポ|(?<![ァ-ヴー])(?:ロリ(?:コン|系|キャラ|顔|声)?|ショタ(?:コン|系|キャラ|声)?|ペド(?:フィリア)?)(?![ァ-ヴー]))/iu

const MINOR_CONTENT_TERM_RE = /(?:児童|女児|男児|小児|幼児|乳幼児|園児|未就学児|小学生|中学生|小中学生|未成年|18歳未満|幼女|子供|子ども|こども|赤ちゃん|赤ん坊|女子小学生|女子中学生|児ポ|(?<![ァ-ヴー])(?:ロリ(?:コン|系|キャラ|顔|声)?|ショタ(?:コン|系|キャラ|声)?|ペド(?:フィリア)?)(?![ァ-ヴー]))/iu

const STANDALONE_UNSAFE_MINOR_RE = /(?:児ポ|児童ポルノ|児童買春|児童虐待|児童性愛|小児性愛|(?<![ァ-ヴー])(?:ロリコン|ショタコン|ペドフィリア|ペド(?![ァ-ヴー])))/iu

const UNSAFE_CONTEXT_TERM_RE = /(?:ポルノ|買春|売春|援交|援助交際|パパ活|淫行|わいせつ|猥褻|性的|性交|性行為|性器|性欲|性癖|性対象|セックス|交尾|中出し|射精|絶頂|オーガズム|フェラ|パイズリ|手コキ|足コキ|素股|オナニー|自慰|ちんこ|ちんぽ|チンポ|まんこ|マンコ|おまんこ|クリトリス|アナル|愛液|潮吹き|勃起|全裸|裸に|服を脱|下着|パンツ|ぱんつ|スク水|ブルマ|おっぱい|エロ|えっち|エッチ|官能|濡れ場|レイプ|強姦|凌辱|輪姦|調教|催眠|触手|監禁|誘拐|拉致|人身売買|臓器売買|虐待|虐殺|処刑|拷問|人体実験|愛好)/iu

// Stricter similarity floor and count cap when a query contains minor-related words such as 「児童」,
// so unrelated jokes/messages that merely share the word are not piled into one prompt.
const MIN_MINOR_RELATED_SCORE = 0.68
const MAX_MINOR_RELATED_ITEMS = 2

function mentionsMinor (...texts) {
  return texts.some(t => typeof t === 'string' && MINOR_QUERY_TERM_RE.test(t))
}

function isUnsafeMinorContent (text) {
  const s = String(text || '')
  if (!s) return false
  if (STANDALONE_UNSAFE_MINOR_RE.test(s)) return true
  return MINOR_CONTENT_TERM_RE.test(s) && UNSAFE_CONTEXT_TERM_RE.test(s)
}

function sanitizeUntrustedLines (text) {
  const s = String(text || '')
  if (!s) return s
  return s
    .split('\n')
    .filter(line => !isUnsafeMinorContent(line))
    .join('\n')
}

module.exports = {
  mentionsMinor,
  isUnsafeMinorContent,
  sanitizeUntrustedLines,
  MIN_MINOR_RELATED_SCORE,
  MAX_MINOR_RELATED_ITEMS
}
