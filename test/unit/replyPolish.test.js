const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { needsPolish, rejected, keptParts, POCKET_DIR } = require('../../src/bot/modules/replyPolish')

test('the vendored yomiyasu-pocket is there, with its version and licence', () => {
  const text = fs.readFileSync(path.join(POCKET_DIR, 'yomiyasu-pocket.txt'), 'utf8')
  assert.match(text, /^次の文章を意味を変えずに読みやすく書き直してください。/)
  const [tag, commit] = fs.readFileSync(path.join(POCKET_DIR, 'VERSION'), 'utf8').trim().split('\n')
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  assert.match(commit, /^[0-9a-f]{40}$/)
  assert.match(fs.readFileSync(path.join(POCKET_DIR, 'LICENSE'), 'utf8'), /^MIT License/)
})

test('only polishes replies that have AI-like phrasing or are long enough to warrant a check', () => {
  assert.equal(needsPolish('やあ！'), false)
  assert.equal(needsPolish('そのゲームなら Cities: Skylines がすごくおすすめだよ！道路を作るだけでも時間が溶けるよ！'), false)
  assert.equal(needsPolish('重要なのは、まず最初の道路の渋滞を解消すること——つまりインターチェンジの配置が一番のカギだよ！'), true)
  assert.equal(needsPolish('あ'.repeat(250)), true)
})

test('keeps the parts of a Discord message a rewrite must not touch', () => {
  assert.deepEqual(keptParts('<@1> と <#2> で <:wave:3> を https://example.com/a?b=1 `npm test`'),
    ['<#2>', '<:wave:3>', '<@1>', '`npm test`', 'https://example.com/a?b=1'])
})

test('uses a rewrite only when it keeps those parts and about the same length', () => {
  const before = '<@1> さん、重要なのは https://example.com を見ることです。そこに全部書いてあります。'
  assert.equal(rejected(before, '<@1> さん、https://example.com を見てください。全部書いてあります。'), null)
  assert.equal(rejected(before, ''), 'empty')
  assert.match(rejected(before, 'https://example.com を見てください。全部書いてあります。'), /mentions/)
  assert.match(rejected(before, '<@1> https://example.com'), /^length/)
})
