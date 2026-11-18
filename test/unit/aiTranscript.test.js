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

test('turns the transcript into rows for the tables: one call row each, one message row for each part', () => {
  const rows = aiTranscript.toRows({
    systems: { h: 'SYS' },
    calls: [
      { at: 't0', model: 'm', purpose: 'mention', system: 'h', tools: ['a'], fromTurn: 0, turns: [{ role: 'user', parts: [{ text: '依頼' }, { picture: { mimeType: 'image/png', bytes: 3 } }] }], response: { finishReason: 'STOP', parts: [{ thought: true, text: '考え' }, { functionCall: { name: 'a', args: { q: 1 } } }] } },
      { at: 't1', model: 'm', purpose: 'mention', system: 'h', fromTurn: 1, turns: [{ role: 'user', parts: [{ functionResponse: { name: 'a', response: { result: 'r' } } }] }], response: { finishReason: 'SAFETY', safetyRatings: [{ category: 'X', blocked: true }], parts: [] } },
      { at: 't2', model: 'u', purpose: 'uncensored', system: 'h2', fromTurn: 0, turns: [{ role: 'user', content: [{ text: 'やあ' }, { picture: true }] }, { role: 'assistant', content: null, tool_calls: [{ function: { name: 'b', arguments: '{}' } }] }], response: { message: { role: 'assistant', content: 'こんにちは' } }, error: null }
    ]
  })
  assert.deepEqual(rows.systems, [{ hash: 'h', text: 'SYS' }])
  const [a, b, c] = rows.calls
  assert.deepEqual([a.seq, a.finishReason, a.tools], [0, 'STOP', ['a']])
  assert.deepEqual(a.messages.map(m => [m.seq, m.direction, m.turn, m.kind, m.name, m.content]), [
    [0, 'sent', 0, 'text', null, '依頼'],
    [1, 'sent', 0, 'picture', null, 'image/png 3 bytes'],
    [2, 'received', null, 'thought', null, '考え'],
    [3, 'received', null, 'function_call', 'a', '{"q":1}']
  ])
  assert.deepEqual([b.finishReason, b.safetyRatings], ['SAFETY', [{ category: 'X', blocked: true }]])
  assert.deepEqual(b.messages.map(m => [m.turn, m.kind, m.content]), [[1, 'function_response', '{"result":"r"}']])
  assert.deepEqual(c.messages.map(m => [m.direction, m.role, m.kind, m.name, m.content]), [
    ['sent', 'user', 'text', null, 'やあ\n[画像]'],
    ['sent', 'assistant', 'function_call', 'b', '{}'],
    ['received', 'assistant', 'text', null, 'こんにちは']
  ])
  assert.equal(aiTranscript.toRows(null), null)
  assert.ok(!Number.isNaN(Date.parse(aiTranscript.toRows({ systems: {}, calls: [{ model: 'm' }] }).calls[0].calledAt)), 'a call without a time is saved at the time it is saved')
})
