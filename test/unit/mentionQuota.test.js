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
    for (const name of ['MENTION_TOKEN_WEIGHTS', 'MENTION_TOKEN_LIMIT_5H', 'MENTION_TOKEN_LIMIT_WEEK', 'MENTION_GUILD_DAILY_LIMIT_OTHER', 'OWNER_GUILD_IDS', 'CREATOR_IDS']) delete process.env[name]
  })

  test('tokens count with cached prompt tokens at a tenth, weighted by what the model costs', () => {
    const meta = { promptTokenCount: 12000, cachedContentTokenCount: 10000, candidatesTokenCount: 300, thoughtsTokenCount: 700 }
    assert.equal(mentionQuota.costOf(meta, 'gemini-3.8-flash'), 4000)
    assert.equal(mentionQuota.costOf(meta, 'gemini-4-argon'), 16000, 'a stronger model counts for more')
    assert.equal(mentionQuota.costOf(meta, 'gemini-4-argon', { flex: true }), 8000, 'Flex inference for half')
    assert.equal(mentionQuota.costOf(meta, 'gemini-3.5-flash-lite'), 1000, 'a lighter one for less')
    assert.equal(mentionQuota.costOf(null, 'gemini-3.8-flash'), 0)
    process.env.MENTION_TOKEN_WEIGHTS = 'gemini-4-argon=6, gemini-3.8-flash = 1.5, broken, x=abc'
    assert.equal(mentionQuota.weightOf('gemini-4-argon'), 6)
    assert.equal(mentionQuota.weightOf('gemini-3.8-flash'), 1.5)
    assert.equal(mentionQuota.weightOf('gemini-9-pro'), 4, 'by kind when not named')
    assert.equal(mentionQuota.weightOf('x'), 1)
  })

  test('per user across servers: 300,000 tokens in five hours from the first use, then refused until it resets', async () => {
    await mentionQuota.record('1', 200000, at(T0))
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 1))).allowed, true, 'under the limit')
    await mentionQuota.record('1', 100000, at(T0, 1))
    const refused = await mentionQuota.take('1', OTHER, at(T0, 2))
    assert.deepEqual(refused, { allowed: false, scope: 'user', window: '5h', label: '5時間', limit: 300000, resetsAt: at(T0, 5) })
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 2))).allowed, false, 'in every server')
    assert.equal((await mentionQuota.take('2', OWNER, at(T0, 2))).allowed, true, 'counted per user')
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 5))).allowed, true, 'the window is over')
    assert.equal(mentionQuota.refusal(refused, at(T0, 2)), '利用上限（5時間あたり 300,000 トークン）に達しました。17:00ごろ（日本時間）からまた使えます。')
  })

  test('a week: 2,000,000 tokens from the first use; the reset date is said when it is another day', async () => {
    for (let i = 0; i < 7; i++) await mentionQuota.record('1', 290000, at(T0, i * 6))
    const refused = await mentionQuota.take('1', OWNER, at(T0, 42))
    assert.equal(refused.window, 'week')
    assert.deepEqual(refused.resetsAt, at(T0, 7 * 24))
    assert.equal(mentionQuota.refusal(refused, at(T0, 42)), '利用上限（1週間あたり 2,000,000 トークン）に達しました。11/6 12:00ごろ（日本時間）からまた使えます。')
  })

  test('the limits can be changed, and 0 turns one off; the bot\'s developers have none', async () => {
    process.env.MENTION_TOKEN_LIMIT_5H = '0'
    process.env.MENTION_TOKEN_LIMIT_WEEK = '1000'
    await mentionQuota.record('1', 1000, at(T0))
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
