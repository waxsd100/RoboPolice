const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installQuotaStore } = require('../helpers/fakes')
const mentionQuota = require('../../src/bot/utils/mentionQuota')

const OWNER = '615170683068219393'
const OTHER = '100'

describe('mentionQuota', () => {
  let counts
  beforeEach(() => { counts = installQuotaStore() })
  afterEach(() => {
    for (const name of ['MENTION_DAILY_LIMIT', 'MENTION_DAILY_LIMIT_OTHER', 'MENTION_GUILD_DAILY_LIMIT_OTHER', 'OWNER_GUILD_IDS']) delete process.env[name]
  })

  test('in the owner\'s server, 30 mentions a day per user by default, then refuses', async () => {
    const now = new Date('2026-10-30T12:00:00+09:00')
    for (let i = 0; i < 30; i++) assert.equal((await mentionQuota.take('1', OWNER, now)).allowed, true)
    assert.deepEqual(await mentionQuota.take('1', OWNER, now), { allowed: false, limit: 30, scope: 'user' })
    assert.equal((await mentionQuota.take('2', OWNER, now)).allowed, true, 'counted per user')
  })

  test('elsewhere, 5 a day per user and 30 a day for the whole server', async () => {
    const now = new Date('2026-10-30T12:00:00+09:00')
    for (let i = 0; i < 5; i++) assert.equal((await mentionQuota.take('1', OTHER, now)).allowed, true)
    assert.deepEqual(await mentionQuota.take('1', OTHER, now), { allowed: false, limit: 5, scope: 'user' })
    // 24 more users bring the server to 30 answered (the refused one is not counted).
    for (let u = 2; u <= 6; u++) for (let i = 0; i < 5; i++) await mentionQuota.take(String(u), OTHER, now)
    assert.equal(counts.get(`mention-quota-guild:${OTHER}:2026-10-30`), 30)
    assert.deepEqual(await mentionQuota.take('7', OTHER, now), { allowed: false, limit: 30, scope: 'guild' })
    assert.equal(counts.get(`mention-quota:${OTHER}:7:2026-10-30`), 0, 'refused by the server limit: not counted against the user')
    assert.equal((await mentionQuota.take('1', OWNER, now)).allowed, true, 'the owner\'s server is counted apart')
  })

  test('OWNER_GUILD_IDS names the owner\'s servers', async () => {
    process.env.OWNER_GUILD_IDS = `${OTHER}, 555`
    const now = new Date('2026-10-30T12:00:00+09:00')
    for (let i = 0; i < 10; i++) assert.equal((await mentionQuota.take('1', OTHER, now)).allowed, true)
  })

  test('the day turns over at midnight Japan time', async () => {
    assert.equal(mentionQuota.today(new Date('2026-10-30T23:59:00+09:00')), '2026-10-30')
    assert.equal(mentionQuota.today(new Date('2026-10-31T00:00:00+09:00')), '2026-10-31')
    process.env.MENTION_DAILY_LIMIT = '1'
    await mentionQuota.take('1', OWNER, new Date('2026-10-30T23:59:00+09:00'))
    assert.equal((await mentionQuota.take('1', OWNER, new Date('2026-10-30T23:59:30+09:00'))).allowed, false)
    assert.equal((await mentionQuota.take('1', OWNER, new Date('2026-10-31T00:00:00+09:00'))).allowed, true)
    assert.deepEqual([...counts.keys()], ['mention-quota:1:2026-10-30', 'mention-quota:1:2026-10-31'])
  })

  test('the limits can be changed, and 0 turns one off', async () => {
    process.env.MENTION_DAILY_LIMIT = '0'
    for (let i = 0; i < 40; i++) assert.equal((await mentionQuota.take('1', OWNER)).allowed, true)
    assert.equal(counts.size, 0)
    process.env.MENTION_DAILY_LIMIT = 'abc'
    assert.equal((await mentionQuota.take('1', OWNER)).limit, 30)
    process.env.MENTION_DAILY_LIMIT_OTHER = '0'
    process.env.MENTION_GUILD_DAILY_LIMIT_OTHER = '2'
    await mentionQuota.take('1', OTHER)
    await mentionQuota.take('2', OTHER)
    assert.equal((await mentionQuota.take('3', OTHER)).scope, 'guild')
  })

  test('lets the mention through when Redis fails', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    mentionQuota.store.increment = async () => { throw new Error('ECONNREFUSED') }
    assert.equal((await mentionQuota.take('1', OTHER)).allowed, true)
    assert.match(warned.mock.calls[0].arguments[0], /ECONNREFUSED/)
  })
})
