// The model sometimes reports how long its text is ("（45文字）", "(文字数: 120)") after being told
// how long it may be. That is never part of the text people should see, so it is taken out. Only
// counts of characters are: "(2026)" or "（3人）" stay.
const SPACE = '[ \\t\\u3000]*'
const NUMBER = '[0-9０-９][0-9０-９,，]*'
const COUNTS = [
  new RegExp(`${SPACE}[（(]\\s*(?:約|全)?\\s*${NUMBER}\\s*(?:文字|字)(?:以内|程度|前後)?\\s*[)）]`, 'g'),
  new RegExp(`${SPACE}[（(]\\s*文字数\\s*[:：]?\\s*${NUMBER}\\s*(?:文字|字)?\\s*[)）]`, 'g'),
  new RegExp(`${SPACE}文字数\\s*[:：]\\s*${NUMBER}\\s*(?:文字|字)?\\s*$`, 'gm')
]

function withoutCharCount (text) {
  if (!text) return text
  return COUNTS.reduce((t, pattern) => t.replace(pattern, ''), String(text)).trim()
}

function fmtSeconds (seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds % 3600 / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

const TIMESTAMP_HEAD_RE = /^(?:(?:[-*+・•]|\d+[.)])\s*)?\*{0,2}(?:\[|［|【)\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\s*(?:[-〜～~–—]|から)\s*(?:\[|［|【)?(?:\d{1,2}:)?\d{1,3}:\d{2}(?:\]|］|】)?)?\s*(?:\]|］|】)\*{0,2}(?:\s*[-—―–:：]\s*|\s*)(.+)$/
const TIMESTAMP_TAIL_RE = /^(?:[-*+・•]|\d+[.)])\s*(.+?)\s*[（(]?(?:\[|［|【)\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\s*(?:[-〜～~–—]|から)\s*(?:\[|［|【)?(?:\d{1,2}:)?\d{1,3}:\d{2}(?:\]|］|】)?)?\s*(?:\]|］|】)[)）]?(?:\s*[-—―–:：]\s*(.*))?$/
const HEADING_OR_RULE_RE = /^(?:#{1,6}\s+.*|[-*_]{3,}|【(?:要約|まとめ|概要|タイムライン|主な(?:話題|内容|流れ)|動画の(?:内容|要約|概要))】\s*)$/
const CHATTER_LINE_RE = /^(?:(?:はい|ええ|わかりました|承知(?:いた)?しました|かしこまりました)[、。！!\s]*)+(?:[^。\n]*(?:要約|まとめ)[^。\n]*)?$|^(?:(?:この|本|以下の?|ご指定の)?\s*(?:YouTube\s*)?(?:動画|配信|アーカイブ)?(?:の(?:内容|様子|流れ))?(?:を|について|の)?\s*)?(?:日本語で\s*)?(?:要約|まとめ)(?:しました|いたします|します|ました|は以下の通り|は次の通り|はこちら|になります|となります)[^。\n]*[。！!：:\s]*$|^(?:以下(?:が|は|に)?[^。\n]{0,30}(?:要約|まとめ|タイムライン|一覧)(?:です|になります|となります)?[。！!：:\s]*)$|^(?:以上(?:が|で)?[^。\n]{0,35}(?:です|ます|でした|となります|になります)[。！!\s]*(?:参考になれば[^。\n]*)?)$|^(?:ご?参考になれば幸いです|何かあればお気軽にお聞きください)[。！!\s]*$/i
const CLOSING_PROSE_RE = /^(?:全体を通して|総じて|まとめると|最後にまとめると|総括すると)/

function cleanItemBody (text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^[-—―–:：\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTimestampLine (line) {
  const head = TIMESTAMP_HEAD_RE.exec(line)
  if (head) {
    const seconds = Number(head[1] || 0) * 3600 + Number(head[2]) * 60 + Number(head[3])
    const body = cleanItemBody(head[4])
    return body ? { seconds, body } : null
  }
  const tail = TIMESTAMP_TAIL_RE.exec(line)
  if (tail) {
    const seconds = Number(tail[2] || 0) * 3600 + Number(tail[3]) * 60 + Number(tail[4])
    const parts = [cleanItemBody(tail[1]), cleanItemBody(tail[5])].filter(Boolean)
    return parts.length ? { seconds, body: parts.join(': ') } : null
  }
  return null
}

// Normalizes video summaries to `- [m:ss] 内容・結果` lines, stripping preambles ("要約しました！"),
// outros ("以上です"), headings, bold markup, and mixed bullet/timestamp styles.
function cleanSummary (text) {
  let raw = withoutCharCount(String(text || ''))
  if (!raw) return ''
  raw = raw.replace(/^```[^\n]*\n([\s\S]*?)\n?```$/g, '$1').trim()
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const hasTimestamps = lines.some(l => parseTimestampLine(l))
  if (!hasTimestamps) {
    return lines
      .filter(l => !HEADING_OR_RULE_RE.test(l) && !CHATTER_LINE_RE.test(l) && !CLOSING_PROSE_RE.test(l))
      .map(l => l.replace(/\*\*([^*\n]+)\*\*/g, '$1'))
      .join('\n')
      .trim()
  }
  const items = []
  for (const line of lines) {
    const parsed = parseTimestampLine(line)
    if (parsed) {
      items.push(`- [${fmtSeconds(parsed.seconds)}] ${parsed.body}`)
      continue
    }
    if (items.length === 0) continue
    if (HEADING_OR_RULE_RE.test(line) || CHATTER_LINE_RE.test(line) || CLOSING_PROSE_RE.test(line)) continue
    if (/^(?:[-*+・•※]|(?:日時|場所|出演|ゲスト|URL|詳細)\s*[:：])/i.test(line)) {
      const sub = cleanItemBody(line.replace(/^[-*+・•]\s*/, ''))
      if (sub) items[items.length - 1] += ` / ${sub}`
    }
  }
  return items.join('\n')
}

module.exports = { withoutCharCount, cleanSummary, fmtSeconds }
