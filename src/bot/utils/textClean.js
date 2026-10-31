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

module.exports = { withoutCharCount }
