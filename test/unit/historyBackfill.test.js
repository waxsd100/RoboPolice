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
  store.saveBackfill = async (guildID, channelID, before, done) => { states[channelID] = { before_id: before, done } }
  store.saveHistory = async rows => { saved.push(...rows); return rows.length }
  global.bot = { user: { id: 'BOT' }, guilds: new Map(), guildSettingsCache: {} }
  delete process.env.HISTORY_BACKFILL_DAYS
  delete process.env.MESSAGE_HISTORY_DAYS
})
afterEach(() => {
  delete process.env.HISTORY_BACKFILL_DAYS
  delete process.env.MESSAGE_HISTORY_DAYS
})

// Messages with IDs from `from` down, one a day back from NOW.
const page = (from, n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({
  id: String(from - i), type: 0, content: `m${from - i}`, attachments: [], author: { id: 'u1' }, timestamp: NOW - (1000 - (from - i)) * DAY, ...extra(i)
}))
const guild = { id: 'g1' }
const channel = { id: 'c1' }

describe('how far back', () => {
  test('HISTORY_BACKFILL_DAYS, else the retention, else 90 days; 0 for everything', () => {
    assert.equal(history.days(), 90)
    process.env.MESSAGE_HISTORY_DAYS = '30'
    assert.equal(history.days(), 30)
    process.env.HISTORY_BACKFILL_DAYS = '365'
    assert.equal(history.days(), 365)
    process.env.HISTORY_BACKFILL_DAYS = '0'
    assert.equal(history.days(), null)
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
    assert.deepEqual(states.c1, { before_id: '871', done: true })
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
