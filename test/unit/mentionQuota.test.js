const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installQuotaStore } = require('../helpers/fakes')
const mentionQuota = require('../../src/bot/utils/mentionQuota')

describe('mentionQuota', () => {
  let counts
  beforeEach(() => { counts = installQuotaStore() })
  afterEach(() => { delete process.env.MENTION_DAILY_LIMIT })

  test('allows 30 mentions a day per user by default, then refuses', async () => {
    const now = new Date('2026-10-30T12:00:00+09:00')
    for (let i = 0; i < 30; i++) assert.equal((await mentionQuota.take('1', now)).allowed, true)
    assert.deepEqual(await mentionQuota.take('1', now), { allowed: false, limit: 30 })
    assert.equal((await mentionQuota.take('2', now)).allowed, true, 'counted per user')
  })

  test('the day turns over at midnight Japan time', async () => {
    assert.equal(mentionQuota.today(new Date('2026-10-30T23:59:00+09:00')), '2026-10-30')
    assert.equal(mentionQuota.today(new Date('2026-10-31T00:00:00+09:00')), '2026-10-31')
    process.env.MENTION_DAILY_LIMIT = '1'
    await mentionQuota.take('1', new Date('2026-10-30T23:59:00+09:00'))
    assert.equal((await mentionQuota.take('1', new Date('2026-10-30T23:59:30+09:00'))).allowed, false)
    assert.equal((await mentionQuota.take('1', new Date('2026-10-31T00:00:00+09:00'))).allowed, true)
    assert.deepEqual([...counts.keys()], ['mention-quota:1:2026-10-30', 'mention-quota:1:2026-10-31'])
  })

  test('MENTION_DAILY_LIMIT changes the limit, and 0 turns it off', async () => {
    process.env.MENTION_DAILY_LIMIT = '0'
    for (let i = 0; i < 40; i++) assert.equal((await mentionQuota.take('1')).allowed, true)
    assert.equal(counts.size, 0)
    process.env.MENTION_DAILY_LIMIT = 'abc'
    assert.equal((await mentionQuota.take('1')).limit, 30)
  })

  test('lets the mention through when Redis fails', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    mentionQuota.store.increment = async () => { throw new Error('ECONNREFUSED') }
    assert.equal((await mentionQuota.take('1')).allowed, true)
    assert.match(warned.mock.calls[0].arguments[0], /ECONNREFUSED/)
  })
})
