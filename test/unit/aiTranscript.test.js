const { test } = require('node:test')
const assert = require('node:assert/strict')
const { trackUsage } = require('../../src/bot/utils/geminiUsage')
const aiTranscript = require('../../src/bot/utils/aiTranscript')

test('records each call, the system instructions once, and only what is new in the conversation', async () => {
  let usage
  await trackUsage(async u => {
    usage = u
    const turn1 = { role: 'user', parts: [{ text: '依頼' }, { inlineData: { mimeType: 'image/png', data: 'A'.repeat(400) } }] }
    aiTranscript.recordGemini({ model: 'm', purpose: 'mention', body: { contents: [turn1] }, system: 'SYS', tools: [{ functionDeclarations: [{ name: 'a' }] }], response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x'.repeat(30000) }] } }] } })
    const turn2 = { role: 'model', parts: [{ text: 'ok' }] }
    aiTranscript.recordGemini({ model: 'm', purpose: 'mention', body: { contents: [turn1, turn2, { role: 'user', parts: [{ text: '次' }] }] }, system: 'SYS', error: new Error('HTTP 500') })
    aiTranscript.recordUncensored({ model: 'u', messages: [{ role: 'system', content: 'USYS' }, { role: 'user', content: 'やあ' }], response: { role: 'assistant', content: 'こんにちは' } })
  })
  const log = aiTranscript.forLog(usage)
  assert.equal(Object.keys(log.systems).length, 2)
  const [a, b, c] = log.calls
  assert.equal(log.systems[a.system], 'SYS')
  assert.equal(b.system, a.system)
  assert.deepEqual(a.tools, ['a'])
  assert.deepEqual(a.turns[0].parts[1], { picture: { mimeType: 'image/png', bytes: 300 } }, 'pictures by type and size')
  assert.ok(a.response.parts[0].text.length < 21000, 'long texts are cut')
  assert.deepEqual([b.fromTurn, b.turns.length, b.error], [1, 2, 'HTTP 500'])
  assert.equal(c.purpose, 'uncensored')
  assert.equal(log.systems[c.system], 'USYS')
  assert.deepEqual(c.turns, [{ role: 'user', content: 'やあ' }])
  assert.equal(c.response.message.content, 'こんにちは')
  assert.equal(aiTranscript.forLog({}), null, 'nothing outside a mention')
})
