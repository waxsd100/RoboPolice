const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const UPDATE = path.resolve(__dirname, '../../src/db/interfaces/postgres/update.js')
const CACHE_GUILD = path.resolve(__dirname, '../../src/bot/utils/cacheGuild.js')
const CACHER = path.resolve(__dirname, '../../src/bot/modules/guildWebhookCacher.js')

// The module under test with its database calls replaced: `cleared` collects every
// [guildID, channelID] whose logging settings were removed.
function load (cleared) {
  for (const file of [UPDATE, CACHE_GUILD, CACHER]) delete require.cache[file]
  require.cache[UPDATE] = { id: UPDATE, filename: UPDATE, loaded: true, exports: { clearEventByID: async (g, c) => { cleared.push([g, c]) } } }
  require.cache[CACHE_GUILD] = { id: CACHE_GUILD, filename: CACHE_GUILD, loaded: true, exports: async () => {} }
  return require(CACHER)
}

function fakeBot (channel) {
  return {
    user: { id: 'bot' },
    guilds: new Map([['g1', { id: 'g1', name: 'Guild' }]]),
    guildSettingsCache: {},
    getChannel: () => channel
  }
}

const channelWith = getWebhooks => ({
  permissionsOf: () => ({ json: { manageWebhooks: true } }),
  getWebhooks,
  createWebhook: async () => ({ id: 'new', token: 'tok' })
})

describe('guildWebhookCacher', () => {
  let saved
  let stored
  beforeEach(() => {
    saved = { bot: global.bot, redis: global.redis, logger: global.logger }
    stored = new Map()
    global.redis = { del: async key => stored.delete(key), set: async (key, value) => stored.set(key, value), get: async key => stored.get(key) }
    global.logger = { warn () {}, info () {}, error () {} }
  })
  afterEach(() => {
    Object.assign(global, saved)
    for (const file of [UPDATE, CACHE_GUILD, CACHER]) delete require.cache[file]
  })

  it('keeps the logging settings when reading the webhooks fails for a passing reason', async () => {
    const cleared = []
    const cacher = load(cleared)
    global.bot = fakeBot(channelWith(async () => { throw Object.assign(new Error('503 Service Temporarily Unavailable'), { code: 503 }) }))
    await cacher('g1', 'c1')
    assert.deepStrictEqual(cleared, [])
  })

  it('keeps them when the bot lost access (Missing Access)', async () => {
    const cleared = []
    const cacher = load(cleared)
    global.bot = fakeBot(channelWith(async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }) }))
    await cacher('g1', 'c2')
    assert.deepStrictEqual(cleared, [])
  })

  it('stops logging to a channel Discord says does not exist, even with no cached settings', async () => {
    const cleared = []
    const cacher = load(cleared)
    global.bot = fakeBot(channelWith(async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }) }))
    stored.set('webhook-c3', 'old|token')
    await cacher('g1', 'c3')
    assert.deepStrictEqual(cleared, [['g1', 'c3']])
    assert.strictEqual(stored.has('webhook-c3'), false)
  })

  it('reuses the bot\'s own webhook and creates one when there is none', async () => {
    const cacher = load([])
    global.bot = fakeBot(channelWith(async () => [
      { id: 'follow', channel_id: 'c4', application_id: null },
      { id: 'mine', token: 't', channel_id: 'c4', application_id: 'bot' }
    ]))
    await cacher('g1', 'c4')
    assert.strictEqual(stored.get('webhook-c4'), 'mine|t')

    global.bot = fakeBot(channelWith(async () => []))
    await cacher('g1', 'c5')
    assert.strictEqual(stored.get('webhook-c5'), 'new|tok')
  })
})
