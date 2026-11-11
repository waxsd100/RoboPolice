const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const update = require('../../src/db/interfaces/postgres/update')
const autoLog = require('../../src/bot/modules/autoLogChannel')
const { ALL_EVENTS } = require('../../src/bot/utils/constants')

function setUp (t, { perms = ['manageChannels', 'manageWebhooks'], logs = {}, channels = [] } = {}) {
  const saved = []
  t.mock.method(update, 'setEventsLogId', async (guildID, channelID, events) => saved.push([guildID, channelID, events]))
  const made = []
  const posted = []
  global.bot = {
    user: { id: 'BOT' },
    guildSettingsCache: { g1: { getEventLogRaw: () => logs } },
    createChannel: async (guildID, name, type, options) => {
      made.push({ guildID, name, type, options })
      return { id: 'new', name }
    },
    createMessage: async (channelID, m) => posted.push([channelID, m.content])
  }
  const guild = {
    id: 'g1',
    channels: new Map(channels.map(c => [c.id, c])),
    members: new Map([['BOT', { permissions: { has: p => perms.includes(p) } }]])
  }
  return { guild, saved, made, posted }
}

afterEach(() => { delete process.env.AUTO_LOG_CHANNEL })

test('on joining, a staff-only log channel is made and every event logs to it', async t => {
  const { guild, saved, made, posted } = setUp(t)
  const channel = await autoLog.startLogging(guild)
  assert.equal(channel.id, 'new')
  assert.equal(made[0].name, 'robopolice-logs')
  const [everyone, bot] = made[0].options.permissionOverwrites
  assert.deepEqual([everyone.id, everyone.type, everyone.deny], ['g1', 0, String(1n << 10n)], 'hidden from @everyone')
  assert.equal(bot.id, 'BOT')
  assert.ok((BigInt(bot.allow) & (1n << 29n)) !== 0n, 'the bot may make webhooks there')
  assert.deepEqual(saved, [['g1', 'new', ALL_EVENTS]])
  assert.match(posted[0][1], /ログを開始しました/)
})

test('an existing log channel of that name is used; a server that logs something, lacks the permissions, or turned it off is left alone', async t => {
  let s = setUp(t, { channels: [{ id: 'old', name: 'robopolice-logs', type: 0 }] })
  assert.equal((await autoLog.startLogging(s.guild)).id, 'old')
  assert.equal(s.made.length, 0)
  t.mock.restoreAll()

  s = setUp(t, { logs: { messageDelete: 'c1' } })
  assert.equal(await autoLog.startLogging(s.guild), null)
  t.mock.restoreAll()

  s = setUp(t, { perms: ['manageWebhooks'] })
  assert.equal(await autoLog.startLogging(s.guild), null)
  assert.equal(s.saved.length, 0)
  t.mock.restoreAll()

  process.env.AUTO_LOG_CHANNEL = 'false'
  s = setUp(t)
  assert.equal(await autoLog.startLogging(s.guild), null)
})

test('sends onboarding embed on setup and posts manual-setup guide to systemChannelID when Manage Channels is missing', async t => {
  const messages = []
  t.mock.method(update, 'setEventsLogId', async () => {})
  global.bot = {
    user: { id: 'BOT' },
    guildSettingsCache: { g1: { getEventLogRaw: () => ({}) } },
    createChannel: async () => ({ id: 'new', name: 'robopolice-logs' }),
    createMessage: async (channelID, m) => messages.push([channelID, m])
  }
  const guildOk = {
    id: 'g1',
    channels: new Map(),
    members: new Map([['BOT', { permissions: { has: p => ['manageChannels', 'manageWebhooks', 'viewAuditLog'].includes(p) } }]])
  }
  await autoLog.startLogging(guildOk)
  assert.equal(messages[0][1].embeds[0].title, '🚀 ロボポリス 初期設定ガイド')
  assert.equal(messages[0][1].embeds[0].fields.length, 3)

  messages.length = 0
  const guildMissing = {
    id: 'g1',
    systemChannelID: 'sys-1',
    channels: new Map([['sys-1', { id: 'sys-1', permissionsOf: () => ({ json: { viewChannel: true, sendMessages: true } }) }]]),
    members: new Map([['BOT', { permissions: { has: p => p === 'manageWebhooks' } }]])
  }
  assert.equal(await autoLog.startLogging(guildMissing), null)
  assert.equal(messages.length, 1)
  assert.equal(messages[0][0], 'sys-1')
  assert.match(messages[0][1].embeds[0].description, /チャンネルの管理/)
  assert.match(messages[0][1].embeds[0].description, /\/setup status/)
})
