const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loggable } = require('../../src/bot/events/error')

test('an Eris error is logged without the API response it carries, and cut short', () => {
  const page = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: String(i), content: 'かわいそうに', author: { primary_guild: { tag: 'BEAM' } } })))
  const text = loggable(`Error creating message from channel messages\nTypeError: x is undefined\n    at new Message (Message.js:1:1)\n${page}`)
  assert.match(text, /^Error creating message from channel messages\nTypeError: x is undefined\n {4}at new Message/)
  assert.match(text, /\(response left out, \d+ characters\)$/)
  assert.doesNotMatch(text, /かわいそうに/)
  assert.equal(loggable(new Error('boom')).split('\n')[0], 'Error: boom')
  assert.match(loggable('x'.repeat(5000)), /… \(5000 characters\)$/)
})
