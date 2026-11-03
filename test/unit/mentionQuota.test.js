const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installQuotaStore } = require('../helpers/fakes')
const mentionQuota = require('../../src/bot/utils/mentionQuota')

const OWNER = '615170683068219393'
const OTHER = '100'
const HOUR = 60 * 60 * 1000
const at = (t, hours = 0) => new Date(Date.parse(t) + hours * HOUR)
const T0 = '2026-10-30T12:00:00+09:00'

describe('mentionQuota', () => {
  let counts
  beforeEach(() => { counts = installQuotaStore() })
  afterEach(() => {
    for (const name of ['MENTION_TOKEN_LIMIT_5H', 'MENTION_TOKEN_LIMIT_WEEK', 'MENTION_GUILD_DAILY_LIMIT_OTHER', 'OWNER_GUILD_IDS', 'CREATOR_IDS']) delete process.env[name]
  })

  test('tokens count with cached prompt tokens at a tenth', () => {
    assert.equal(mentionQuota.weightedTokens({ prompt: 12000, cached: 10000, output: 300, thoughts: 700 }), 4000)
    assert.equal(mentionQuota.weightedTokens(null), 0)
  })

  test('per user across servers: 300,000 tokens in five hours from the first use, then refused until it resets', async () => {
    await mentionQuota.record('1', { prompt: 200000, cached: 0, output: 0, thoughts: 0 }, at(T0))
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 1))).allowed, true, 'under the limit')
    await mentionQuota.record('1', { prompt: 100000, cached: 0, output: 0, thoughts: 0 }, at(T0, 1))
    const refused = await mentionQuota.take('1', OTHER, at(T0, 2))
    assert.deepEqual(refused, { allowed: false, scope: 'user', window: '5h', label: '5時間', limit: 300000, resetsAt: at(T0, 5) })
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 2))).allowed, false, 'in every server')
    assert.equal((await mentionQuota.take('2', OWNER, at(T0, 2))).allowed, true, 'counted per user')
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 5))).allowed, true, 'the window is over')
    assert.equal(mentionQuota.refusal(refused, at(T0, 2)), '利用上限（5時間あたり 300,000 トークン）に達しました。17:00ごろ（日本時間）からまた使えます。')
  })

  test('a week: 2,000,000 tokens from the first use; the reset date is said when it is another day', async () => {
    for (let i = 0; i < 7; i++) await mentionQuota.record('1', { prompt: 290000, cached: 0, output: 0, thoughts: 0 }, at(T0, i * 6))
    const refused = await mentionQuota.take('1', OWNER, at(T0, 42))
    assert.equal(refused.window, 'week')
    assert.deepEqual(refused.resetsAt, at(T0, 7 * 24))
    assert.equal(mentionQuota.refusal(refused, at(T0, 42)), '利用上限（1週間あたり 2,000,000 トークン）に達しました。11/6 12:00ごろ（日本時間）からまた使えます。')
  })

  test('the limits can be changed, and 0 turns one off; the bot\'s developers have none', async () => {
    process.env.MENTION_TOKEN_LIMIT_5H = '0'
    process.env.MENTION_TOKEN_LIMIT_WEEK = '1000'
    await mentionQuota.record('1', { prompt: 1000, cached: 0, output: 0, thoughts: 0 }, at(T0))
    assert.equal(counts.has('mention-tokens:5h:1'), false)
    assert.equal((await mentionQuota.take('1', OWNER, at(T0))).window, 'week')
    process.env.CREATOR_IDS = '1'
    assert.equal((await mentionQuota.take('1', OWNER, at(T0))).allowed, true)
  })

  test('outside the owner\'s server, the whole server has 30 mentions a day (Japan time)', async () => {
    const now = new Date('2026-10-30T12:00:00+09:00')
    for (let u = 1; u <= 30; u++) assert.equal((await mentionQuota.take(String(u), OTHER, now)).allowed, true)
    assert.deepEqual(await mentionQuota.take('31', OTHER, now), { allowed: false, scope: 'guild', limit: 30 })
    assert.equal(counts.get(`mention-quota-guild:${OTHER}:2026-10-30`), 31)
    assert.equal((await mentionQuota.take('31', OTHER, new Date('2026-10-31T00:00:00+09:00'))).allowed, true, 'the next day in Japan')
    assert.equal((await mentionQuota.take('31', OWNER, now)).allowed, true, 'not in the owner\'s server')
    process.env.OWNER_GUILD_IDS = OTHER
    assert.equal((await mentionQuota.take('32', OTHER, now)).allowed, true, 'OWNER_GUILD_IDS names the owner\'s servers')
    delete process.env.OWNER_GUILD_IDS
    process.env.MENTION_GUILD_DAILY_LIMIT_OTHER = '0'
    assert.equal((await mentionQuota.take('33', OTHER, now)).allowed, true)
  })

  test('lets the mention through when Redis fails', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    mentionQuota.store.get = async () => { throw new Error('ECONNREFUSED') }
    assert.equal((await mentionQuota.take('1', OTHER)).allowed, true)
    assert.match(warned.mock.calls[0].arguments[0], /ECONNREFUSED/)
  })
})
