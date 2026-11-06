const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { priceOf, usdOf } = require('../../src/bot/utils/geminiPrices')
require('../helpers/fakes') // global.logger

afterEach(() => { delete process.env.MENTION_TOKEN_PRICES })

test('prices from the list, by date', () => {
  assert.deepEqual(priceOf('gemini-3.8-flash', new Date('2026-12-31T23:59:59Z')), { input: 0.75, cached: 0.075, output: 3.75, imageOutput: 3.75 })
  assert.deepEqual(priceOf('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z')), { input: 1.5, cached: 0.15, output: 7.5, imageOutput: 7.5 })
})

test('an image model\'s images cost their own price', () => {
  const meta = { promptTokenCount: 100, candidatesTokenCount: 1300, candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }, { modality: 'IMAGE', tokenCount: 1290 }] }
  // 100 × $0.50 + 10 × $3 + 1,290 × $60, per million.
  assert.equal(usdOf(meta, 'gemini-3.1-flash-image', { now: new Date('2026-11-03T00:00:00Z') }), (50 + 30 + 77400) / 1e6)
})

test('a model not listed is priced as the usual reply model, once warned; MENTION_TOKEN_PRICES adds one', (t) => {
  const warned = t.mock.method(global.logger, 'warn', () => {})
  const now = new Date('2026-11-03T00:00:00Z')
  assert.deepEqual(priceOf('gemini-9-new', now), priceOf('gemini-3.8-flash', now))
  priceOf('gemini-9-new', now)
  assert.equal(warned.mock.callCount(), 1)
  process.env.MENTION_TOKEN_PRICES = '{"gemini-9-new": {"input": 3, "output": 12}}'
  assert.deepEqual(priceOf('gemini-9-new', now), { input: 3, cached: 0.3, output: 12, imageOutput: 12 })
  process.env.MENTION_TOKEN_PRICES = 'not json'
  assert.deepEqual(priceOf('gemini-4-argon', now), { input: 2, cached: 0.1, output: 10, imageOutput: 10 })
})

test('a model that charges more for a long prompt is counted at its long price past it', () => {
  const { usdOf } = require('../../src/bot/utils/geminiPrices')
  const now = new Date('2026-11-06T00:00:00Z')
  const short = usdOf({ promptTokenCount: 100000, candidatesTokenCount: 1000 }, 'gemini-3.1-pro-preview', { now })
  assert.equal(Math.round(short * 1e6) / 1e6, (100000 * 2 + 1000 * 12) / 1e6)
  const long = usdOf({ promptTokenCount: 300000, candidatesTokenCount: 1000 }, 'gemini-3.1-pro-preview', { now })
  assert.equal(Math.round(long * 1e6) / 1e6, (300000 * 4 + 1000 * 18) / 1e6)
  assert.equal(usdOf({ promptTokenCount: 1e6, candidatesTokenCount: 0 }, 'gemini-2.5-flash-lite', { now }), 0.1)
})
