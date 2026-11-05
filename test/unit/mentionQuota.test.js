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
    for (const name of ['MENTION_FLEX_AT_PERCENT', 'MENTION_TOKEN_PRICES', 'MENTION_TOKEN_LIMIT_5H', 'MENTION_TOKEN_LIMIT_WEEK', 'MENTION_GUILD_DAILY_LIMIT_OTHER', 'OWNER_GUILD_IDS', 'CREATOR_IDS']) delete process.env[name]
  })

  test('a response counts by what it cost on Gemini\'s price list, in tokens of the usual model\'s input', () => {
    const now = new Date('2026-11-03T12:00:00Z')
    const meta = { promptTokenCount: 12000, cachedContentTokenCount: 10000, candidatesTokenCount: 300, thoughtsTokenCount: 700 }
    // 2,000 × $0.75 + 10,000 × $0.075 (cached) + 1,000 × $3.75 (answer and thinking), in $0.75 tokens.
    assert.equal(mentionQuota.costOf(meta, 'gemini-3.8-flash', { now }), 8000)
    assert.equal(mentionQuota.costOf(meta, 'gemini-4-argon', { now }), 20000, '$2 / $0.10 / $10')
    assert.equal(mentionQuota.costOf(meta, 'gemini-4-argon', { now, flex: true }), 10000, 'Flex inference for half')
    assert.equal(mentionQuota.costOf(meta, 'gemini-4-argon', { now: new Date('2026-12-01T00:00:00Z') }), 40000, 'from the date its price changes')
    assert.equal(Math.round(mentionQuota.costOf(meta, 'gemini-3.5-flash-lite', { now })), 4533, 'a cheaper model for less')
    assert.equal(mentionQuota.costOf(null, 'gemini-3.8-flash'), 0)
  })

  test('per user across servers: 150,000 tokens in five hours from the first use, then refused until it resets', async () => {
    await mentionQuota.record('1', 100000, at(T0))
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 1))).allowed, true, 'under the limit')
    await mentionQuota.record('1', 50000, at(T0, 1))
    const refused = await mentionQuota.take('1', OTHER, at(T0, 2))
    assert.deepEqual(refused, { allowed: false, scope: 'user', window: '5h', label: '5時間', limit: 150000, resetsAt: at(T0, 5) })
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 2))).allowed, false, 'in every server')
    assert.equal((await mentionQuota.take('2', OWNER, at(T0, 2))).allowed, true, 'counted per user')
    assert.equal((await mentionQuota.take('1', OWNER, at(T0, 5))).allowed, true, 'the window is over')
    assert.equal(mentionQuota.refusal(refused, at(T0, 2)), '利用上限（5時間あたり 150,000 トークン）に達しました。17:00ごろ（日本時間）からまた使えます。')
  })

  test('a week: 750,000 tokens from the first use; the reset date is said when it is another day', async () => {
    for (let i = 0; i < 6; i++) await mentionQuota.record('1', 140000, at(T0, i * 6))
    const refused = await mentionQuota.take('1', OWNER, at(T0, 36))
    assert.equal(refused.window, 'week')
    assert.deepEqual(refused.resetsAt, at(T0, 7 * 24))
    assert.equal(mentionQuota.refusal(refused, at(T0, 36)), '利用上限（1週間あたり 750,000 トークン）に達しました。11/6 12:00ごろ（日本時間）からまた使えます。')
  })

  test('the limits can be changed, and 0 turns one off; the bot\'s developers have none', async () => {
    process.env.MENTION_TOKEN_LIMIT_5H = '0'
    process.env.MENTION_TOKEN_LIMIT_WEEK = '1000'
    await mentionQuota.record('1', 1000, at(T0))
    assert.equal(counts.get('mention-tokens:5h:1'), 1000, 'still counted: another server may limit it')
    assert.equal((await mentionQuota.take('1', OWNER, at(T0))).window, 'week')
    process.env.CREATOR_IDS = '1'
    assert.equal((await mentionQuota.take('1', OWNER, at(T0))).allowed, true)
  })

  test('a server can have its own limits; use is counted across servers and measured against the server asked in', async () => {
    await mentionQuota.record('1', 100000, at(T0))
    assert.equal((await mentionQuota.take('1', OWNER, at(T0), { limits: { '5h': 50000 } })).window, '5h', 'tighter here')
    assert.equal((await mentionQuota.take('1', OTHER, at(T0), { limits: { '5h': 500000, flexAt: 0 } })).allowed, true, 'looser there')
    assert.equal((await mentionQuota.take('1', OTHER, at(T0), { limits: { '5h': 0, week: 0 } })).allowed, true, '0: no limit in that server')
    assert.equal(mentionQuota.windowLimit(mentionQuota.WINDOWS[0], { '5h': null }), 150000, 'null: the default')
  })

  test('a server with no limits (unlimited): nothing refused or slowed, no daily cap, use still counted', async () => {
    await mentionQuota.record('1', 10 ** 9, at(T0))
    assert.deepEqual(await mentionQuota.take('1', OTHER, at(T0), { limits: { unlimited: true } }), { allowed: true, flex: false })
    assert.equal(counts.get(`mention-quota-guild:${OTHER}:2026-10-30`), undefined, 'not counted against the daily cap')
    assert.equal((await mentionQuota.take('1', OTHER, at(T0))).allowed, false, 'limited again elsewhere')
  })

  test('past MENTION_FLEX_AT_PERCENT (80) of a window, mentions go to Flex; a server can set its own share, 0 for never', async () => {
    await mentionQuota.record('1', 110000, at(T0))
    assert.deepEqual(await mentionQuota.take('1', OWNER, at(T0)), { allowed: true, flex: false }, 'at 73%')
    await mentionQuota.record('1', 10000, at(T0))
    const slow = await mentionQuota.take('1', OWNER, at(T0))
    assert.equal(slow.flex, true, 'at 80%')
    assert.equal(slow.window, '5h')
    assert.equal(Math.round(slow.used * 100), 80)
    assert.equal((await mentionQuota.take('1', OWNER, at(T0), { limits: { flexAt: 90 } })).flex, false, 'the server says 90%')
    assert.equal((await mentionQuota.take('1', OWNER, at(T0), { limits: { flexAt: 0 } })).flex, false, 'the server turned it off')
    process.env.MENTION_FLEX_AT_PERCENT = '50'
    assert.equal((await mentionQuota.take('2', OWNER, at(T0))).flex, false, 'someone with no use')
    process.env.CREATOR_IDS = '1'
    assert.deepEqual(await mentionQuota.take('1', OWNER, at(T0)), { allowed: true, flex: false }, 'the developers are never slowed')
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
