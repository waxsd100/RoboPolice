const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installLoadStore } = require('../helpers/fakes')
const load = require('../../src/bot/utils/geminiLoad')

const HOUR = load.BUCKET_MS
let counts
beforeEach(() => { counts = installLoadStore() })
afterEach(() => {
  for (const name of ['GEMINI_HOURLY_BUDGET', 'GEMINI_LOAD_MEDIUM_AT', 'GEMINI_LOAD_FLEX_AT']) delete process.env[name]
  load.reset()
})

test('the past hour is this bucket and the part of the last one still in the window', () => {
  assert.equal(load.spent([100, 1000], 10 * HOUR), 1100, 'at the start of a bucket: all of the last')
  assert.equal(load.spent([100, 1000], 10 * HOUR + HOUR / 4), 850)
})

test('levels by the share of GEMINI_HOURLY_BUDGET (2,000,000): 50% medium thinking, 80% low thinking and Flex for all', async () => {
  const now = 100 * HOUR
  assert.equal((await load.refresh(now)).level, 0)
  load.record(1000000, now)
  load.reset()
  assert.deepEqual(await load.refresh(now), { level: 1, share: 0.5, at: now })
  assert.equal(load.cappedThinking('high', 1), 'medium')
  assert.equal(load.cappedThinking('low', 1), 'low', 'never raised')
  load.record(600000, now)
  load.reset()
  assert.equal((await load.refresh(now)).level, 2)
  assert.equal(load.cappedThinking('high', 2), 'low')
  assert.equal(load.flexForAll(), true)
  assert.equal(counts.get(`gemini-load:${100}`), 1600000)
})

test('read again only after 30 seconds, and the thresholds and budget can be set; 0 turns it off', async () => {
  const now = 100 * HOUR
  await load.refresh(now)
  load.record(2000000, now)
  assert.equal((await load.refresh(now + 1000)).level, 0, 'kept')
  assert.equal((await load.refresh(now + 31000)).level, 2, 'read again')
  process.env.GEMINI_LOAD_FLEX_AT = '150'
  load.reset()
  assert.equal((await load.refresh(now)).level, 1)
  process.env.GEMINI_HOURLY_BUDGET = '0'
  assert.equal((await load.refresh(now)).level, 0)
  assert.equal(load.flexForAll(), false)
})

test('nothing changes when Redis cannot be read', async () => {
  load.store.get = async () => { throw new Error('ECONNREFUSED') }
  assert.equal((await load.refresh(100 * HOUR)).level, 0)
})
