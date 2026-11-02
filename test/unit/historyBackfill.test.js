// Reading channels' history back: which channels, which messages, how far back, and where it got to.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { perms } = require('../helpers/fakes')
const store = require('../../src/db/interfaces/postgres/messageHistory')
const history = require('../../src/bot/modules/historyBackfill')

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-02T00:00:00Z')

let saved, states
beforeEach(() => {
  saved = []
  states = {}
  store.backfillState = async id => states[id] || null
  store.saveBackfill = async (guildID, channelID, o) => {
    states[channelID] = { before_id: o.beforeID, done: o.done, read_count: o.readCount, reached_start: o.reachedStart, limit_start: o.limitStart, limit_max: o.limitMax }
  }
  store.saveHistory = async rows => { saved.push(...rows); return rows.length }
  global.bot = { user: { id: 'BOT' }, guilds: new Map(), guildSettingsCache: {} }
  clearSettings()
})
afterEach(clearSettings)
function clearSettings () {
  for (const name of ['HISTORY_BACKFILL_DAYS', 'HISTORY_BACKFILL_SINCE', 'HISTORY_BACKFILL_MAX_MESSAGES', 'MESSAGE_HISTORY_DAYS']) delete process.env[name]
}

// Messages with IDs from `from` down, one a day back from NOW.
const page = (from, n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({
  id: String(from - i), type: 0, content: `m${from - i}`, attachments: [], author: { id: 'u1' }, timestamp: NOW - (1000 - (from - i)) * DAY, ...extra(i)
}))
const guild = { id: 'g1' }
const channel = { id: 'c1' }

describe('how far back', () => {
  const daysBack = t => t === -Infinity ? null : Math.round((NOW - t) / DAY)

  test('by days: HISTORY_BACKFILL_DAYS, else 90; 0 for no limit; never past the retention', () => {
    assert.equal(daysBack(history.startOf(NOW)), 90)
    process.env.HISTORY_BACKFILL_DAYS = '365'
    assert.equal(daysBack(history.startOf(NOW)), 365)
    process.env.HISTORY_BACKFILL_DAYS = '0'
    assert.equal(daysBack(history.startOf(NOW)), null)
    process.env.MESSAGE_HISTORY_DAYS = '30'
    assert.equal(daysBack(history.startOf(NOW)), 30, 'older ones would be pruned at once')
  })

  test('by date: HISTORY_BACKFILL_SINCE (the start of that day in Japan); with days too, whichever is later', () => {
    process.env.HISTORY_BACKFILL_SINCE = '2026-01-01'
    assert.equal(history.startOf(NOW), Date.parse('2025-12-31T15:00:00Z'), 'no 90-day default when a date is given')
    process.env.HISTORY_BACKFILL_DAYS = '30'
    assert.equal(daysBack(history.startOf(NOW)), 30)
    process.env.HISTORY_BACKFILL_SINCE = '2026-10-30'
    assert.equal(history.startOf(NOW), Date.parse('2026-10-29T15:00:00Z'))
    process.env.HISTORY_BACKFILL_SINCE = '2026/10/30'
    assert.equal(daysBack(history.startOf(NOW)), 30, 'a date not written YYYY-MM-DD is ignored')
  })

  test('by count: HISTORY_BACKFILL_MAX_MESSAGES per channel; unset or 0 for no limit', () => {
    assert.equal(history.maxMessages(), null)
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '0'
    assert.equal(history.maxMessages(), null)
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '5000'
    assert.equal(history.maxMessages(), 5000)
  })
})

describe('readChannel', () => {
  test('pages back until the history ends, storing each message with its own time; remembers where it got to', async () => {
    process.env.HISTORY_BACKFILL_DAYS = '0'
    const pages = [page(1000, 100), page(900, 30)]
    const asked = []
    const added = await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async (id, o) => { asked.push(o.before); return pages.shift() } })
    assert.equal(added, 130)
    assert.deepEqual(asked, [undefined, '901'])
    assert.equal(saved[0].ts, new Date(NOW).toISOString())
    assert.deepEqual({ id: saved[0].id, channelID: saved[0].channelID, guildID: saved[0].guildID, content: saved[0].content }, { id: '1000', channelID: 'c1', guildID: 'g1', content: 'm1000' })
    assert.deepEqual(states.c1, { before_id: '871', done: true, read_count: 130, reached_start: true, limit_start: null, limit_max: null })
    // Done: not read again.
    assert.equal(await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async () => { throw new Error('read again') } }), 0)
  })

  test('stops at the start of the window, and goes on from where a restart left it', async () => {
    process.env.HISTORY_BACKFILL_DAYS = '50'
    states.c1 = { before_id: '981', done: false }
    const asked = []
    await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async (id, o) => { asked.push(o.before); return page(980, 100) } })
    assert.deepEqual(asked, ['981'])
    assert.deepEqual(saved.map(r => r.id), Array.from({ length: 31 }, (_, i) => String(980 - i)), 'only the last 50 days')
    assert.equal(states.c1.done, true)
  })

  test('stops after HISTORY_BACKFILL_MAX_MESSAGES of the channel, counting across restarts', async () => {
    process.env.HISTORY_BACKFILL_DAYS = '0'
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '150'
    states.c1 = { before_id: '951', read_count: 50, done: false }
    const limits = []
    await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async (id, o) => { limits.push(o.limit); return page(Number(o.before) - 1, o.limit) } })
    assert.deepEqual(limits, [100], 'the 100 left')
    assert.deepEqual(states.c1, { before_id: '851', done: true, read_count: 150, reached_start: false, limit_start: null, limit_max: 150 })
    assert.equal(saved.length, 100)
  })

  test('the date limit with a count: whichever comes first', async () => {
    process.env.HISTORY_BACKFILL_SINCE = '2026-10-23' // messages 0 to 10 days back are on or after it
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '1000'
    await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async (id, o) => page(1000, o.limit) })
    assert.equal(saved.length, 11)
    assert.equal(states.c1.done, true)
  })

  test('wider limits later read on from where it stopped; narrower or the same do not', async () => {
    // A channel with 1000 messages, one a day: message n was sent 1000 - n days before NOW.
    const channelHistory = async (id, o) => {
      const from = o.before ? Number(o.before) - 1 : 1000
      return page(from, Math.max(0, Math.min(o.limit, from)))
    }
    const read = () => history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: channelHistory })
    process.env.HISTORY_BACKFILL_DAYS = '30'
    await read()
    assert.equal(saved.length, 31)
    assert.equal(states.c1.before_id, '970')
    assert.equal(await read(), 0, 'the same limits: not read again')
    process.env.HISTORY_BACKFILL_DAYS = '20'
    assert.equal(await read(), 0, 'narrower: not read again')

    // More days: on from message 970, not from the newest.
    process.env.HISTORY_BACKFILL_DAYS = '60'
    saved.length = 0
    await read()
    assert.deepEqual([saved[0].id, saved.at(-1).id, saved.length], ['969', '940', 30])
    // An earlier date.
    process.env.HISTORY_BACKFILL_DAYS = '0'
    process.env.HISTORY_BACKFILL_SINCE = new Date(NOW - 100 * DAY + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    saved.length = 0
    await read()
    assert.equal(saved.at(-1).id, '900')
    // A count limit, then a higher one.
    delete process.env.HISTORY_BACKFILL_SINCE
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '150'
    saved.length = 0
    await read()
    assert.equal(states.c1.read_count, 150)
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '200'
    saved.length = 0
    await read()
    assert.deepEqual([saved[0].id, saved.length, states.c1.read_count], ['850', 50, 200])
    // No limit at all: to the start of the channel, then never again.
    delete process.env.HISTORY_BACKFILL_MAX_MESSAGES
    await read()
    assert.equal(states.c1.reached_start, true)
    assert.equal(states.c1.read_count, 1000)
    process.env.HISTORY_BACKFILL_MAX_MESSAGES = '5000'
    assert.equal(await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async () => { throw new Error('read again') } }), 0)
  })

  test('leaves out bots, the bot itself and automod notices; keeps image URLs', async () => {
    const batch = page(1000, 5, i => [
      { author: { id: 'b', bot: true } },
      { author: { id: 'BOT' } },
      { type: 24 },
      { attachments: [{ url: 'https://cdn/a.png', content_type: 'image/png' }, { url: 'https://cdn/a.png', content_type: 'image/png' }, { url: 'https://cdn/f.zip', content_type: 'application/zip' }] },
      { content: '' }
    ][i])
    await history.readChannel(guild, channel, { wait: 0, now: NOW, getMessages: async () => batch })
    assert.deepEqual(saved.map(r => [r.id, r.imageUrls, r.content]), [['997', ['https://cdn/a.png'], 'm997'], ['996', [], 'None']])
  })
})

describe('backfillGuild', () => {
  const settings = (needs, ignored = []) => ({ needsMessageCache: () => needs, isChannelIgnored: id => ignored.includes(id) })
  const ch = (id, type = 0, canRead = true) => ({ id, type, name: id, permissionsOf: () => perms(canRead ? ['viewChannel', 'readMessageHistory'] : ['viewChannel']) })

  test('only servers that keep messages; only channels the bot can read back and the server does not ignore', async () => {
    const g = { id: 'g1', channels: new Map([['a', ch('a')], ['b', ch('b', 2)], ['c', ch('c', 4)], ['d', ch('d', 0, false)], ['e', ch('e')]]), threads: new Map([['t', ch('t', 11)]]) }
    global.bot.guildSettingsCache.g1 = settings(true, ['e'])
    const read = []
    global.bot.getMessages = async id => { read.push(id); return [] }
    await history.backfillGuild(g, { wait: 0 })
    assert.deepEqual(read, ['a', 'b', 't'])
    global.bot.guildSettingsCache.g1 = settings(false)
    read.length = 0
    states = {}
    await history.backfillGuild(g, { wait: 0 })
    assert.deepEqual(read, [], 'no message log: nothing is stored')
  })

  test('a channel that cannot be read is tried again next time; the rest go on', async (t) => {
    t.mock.method(global.logger, 'warn', () => {})
    const g = { id: 'g1', channels: new Map([['a', ch('a')], ['b', ch('b')]]) }
    global.bot.guildSettingsCache.g1 = settings(true)
    global.bot.getMessages = async id => { if (id === 'a') throw new Error('Missing Access'); return page(1000, 3) }
    assert.equal(await history.backfillGuild(g, { wait: 0 }), 3)
    assert.equal(states.a, undefined)
  })
})
