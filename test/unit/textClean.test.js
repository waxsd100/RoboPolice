const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withoutCharCount } = require('../../src/bot/utils/textClean')

test('takes out the counts of characters the model writes, and nothing else', () => {
  const cases = [
    ['草が生えている。笑ったときに使う（23文字）', '草が生えている。笑ったときに使う'],
    ['説明です (約120字)', '説明です'],
    ['要約です（1500文字以内）', '要約です'],
    ['（全４５文字）おわり', 'おわり'],
    ['本文\n文字数：150', '本文'],
    ['本文（文字数: 98）', '本文'],
    ['2026年（3人）で開催 (2026)', '2026年（3人）で開催 (2026)'],
    ['[12:34] 告知（2回目）', '[12:34] 告知（2回目）']
  ]
  for (const [input, expected] of cases) assert.equal(withoutCharCount(input), expected, input)
  assert.equal(withoutCharCount(null), null)
})
