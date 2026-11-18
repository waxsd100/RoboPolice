const { test } = require('node:test')
const assert = require('node:assert/strict')
const { relevant } = require('../../src/bot/utils/relevance')

const ids = items => items.map(i => i.id)
const at = (...scores) => scores.map((score, i) => ({ id: `r${i}`, score }))

test('only as many as the scores say: within the window of the best, before the first sharp drop, at least the minimum', () => {
  assert.deepEqual(ids(relevant(at(0.9, 0.89, 0.88, 0.7))), ['r0', 'r1', 'r2'], 'not one far below')
  assert.deepEqual(ids(relevant(at(0.9, 0.86, 0.85))), ['r0'], 'cut at a sharp drop, though within the window')
  assert.deepEqual(ids(relevant(at(0.9, 0.89, 0.88), { limit: 2 })), ['r0', 'r1'])
  assert.deepEqual(ids(relevant(at(0.5, 0.49), { min: 0.55 })), [], 'none when even the best is not close')
  assert.deepEqual(ids(relevant(at(0.6, 0.9))), ['r1'], 'best first, whatever the order given')
  assert.deepEqual(relevant([]), [])
  assert.deepEqual(ids(relevant([{ id: 'x' }, { id: 'y', score: 0.7 }])), ['y'], 'one without a score is left out')
})
