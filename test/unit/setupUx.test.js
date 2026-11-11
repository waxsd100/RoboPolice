const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const Eris = require('eris')
const { ALL_EVENTS } = require('../../src/bot/utils/constants')
const { commands } = require('../../src/bot/utils/slashcommandconstants')
const { EVENT_LABELS, formatPermission, formatPermissions, formatEventName } = require('../../src/bot/utils/displayLabels')
const { syncGlobalSlashCommands } = require('../../src/bot/utils/syncSlashCommands')

afterEach(() => {
  delete process.env.AUTO_SYNC_COMMANDS
  delete process.env.CREATOR_IDS
  delete process.env.YOUTUBE_API_KEY
})

test('displayLabels covers every audit event and formats permissions in Japanese and English', () => {
  for (const event of ALL_EVENTS) {
    assert.ok(EVENT_LABELS.ja[event], `ja label for ${event}`)
    assert.ok(EVENT_LABELS.en[event], `en label for ${event}`)
    assert.notEqual(formatEventName(event, 'ja'), event)
  }
  assert.equal(formatPermission('manageWebhooks', 'ja'), 'ウェブフックの管理')
  assert.equal(formatPermission('manageWebhooks', 'en'), 'Manage Webhooks')
  assert.equal(formatPermissions(['manageChannels', 'viewAuditLog'], 'ja'), '**チャンネルの管理**・**監査ログの表示**')
  assert.equal(formatPermissions(['manageChannels', 'viewAuditLog'], 'en'), '**Manage Channels**, **View Audit Log**')
})

test('syncGlobalSlashCommands registers on fresh setup, skips when unchanged, and updates on schema change', async () => {
  let bulkCalls = 0
  let stored = []
  const fakeBot = {
    getCommands: async () => stored,
    bulkEditCommands: async next => {
      bulkCalls++
      stored = JSON.parse(JSON.stringify(next))
    }
  }

  // Fresh bot with 0 commands registered -> registers automatically
  assert.equal(await syncGlobalSlashCommands(fakeBot), true)
  assert.equal(bulkCalls, 1)
  assert.equal(stored.length, commands.length)

  // Already in sync -> zero PUT calls
  assert.equal(await syncGlobalSlashCommands(fakeBot), false)
  assert.equal(bulkCalls, 1)

  // Stale description on Discord -> updates automatically
  stored[0].description = 'outdated description'
  assert.equal(await syncGlobalSlashCommands(fakeBot), true)
  assert.equal(bulkCalls, 2)

  // Disabled via env -> skips even if empty
  process.env.AUTO_SYNC_COMMANDS = 'false'
  stored = []
  assert.equal(await syncGlobalSlashCommands(fakeBot), false)
  assert.equal(bulkCalls, 2)
})

test('interactionCreate gives ephemeral feedback on expired or unauthorized component clicks and localizes missing permissions', async () => {
  const interactionCreate = require('../../src/bot/events/interactionCreate')
  global.bot = {
    user: { id: 'BOT', username: 'RoboPolice', discriminator: '0', avatarURL: 'a', dynamicAvatarURL: () => 'a' },
    getChannel: () => ({ permissionsOf: () => ({ json: {} }) }),
    guilds: new Map([['g1', { id: 'g1', roles: new Map() }]])
  }

  // 1. Expired component click
  const expiredNotices = []
  const expiredClick = Object.create(Eris.ComponentInteraction.prototype)
  Object.assign(expiredClick, {
    locale: 'ja',
    applicationID: 'BOT',
    data: { custom_id: 'expired-id' },
    member: { user: { id: 'u1' } },
    createMessage: async m => expiredNotices.push(m)
  })
  await interactionCreate.handle(expiredClick)
  assert.equal(expiredNotices.length, 1)
  assert.equal(expiredNotices[0].flags, Eris.Constants.MessageFlags.EPHEMERAL)
  assert.match(expiredNotices[0].content, /有効期限が切れました/)

  // 2. Unauthorized user clicking someone else's active button
  let resolvedOwner = false
  const waitPromise = interactionCreate.awaitCustomID('locked-btn', 'owner-user', 5000).then(() => { resolvedOwner = true })
  const otherNotices = []
  const otherClick = Object.create(Eris.ComponentInteraction.prototype)
  Object.assign(otherClick, {
    locale: 'en-US',
    applicationID: 'BOT',
    data: { custom_id: 'locked-btn' },
    member: { user: { id: 'intruder' } },
    createMessage: async m => otherNotices.push(m)
  })
  await interactionCreate.handle(otherClick)
  assert.equal(resolvedOwner, false)
  assert.match(otherNotices[0].content, /Only <@owner-user>/)
  interactionCreate.cancelCustomID('locked-btn')
  assert.ok(waitPromise)

  // 3. Localized missing user permissions on /stoplogging
  const permReplies = []
  const cmdInteraction = Object.create(Eris.CommandInteraction.prototype)
  Object.assign(cmdInteraction, {
    locale: 'ja',
    applicationID: 'BOT',
    guildID: 'g1',
    data: { name: 'stoplogging', options: [] },
    channel: {
      id: 'c1',
      permissionsOf: () => ({ json: { manageChannels: true, manageWebhooks: false } })
    },
    member: {
      id: 'u1',
      roles: [],
      user: { id: 'u1', username: 'u', discriminator: '0', avatarURL: 'a', dynamicAvatarURL: () => 'a' }
    },
    createMessage: async m => permReplies.push(m)
  })
  await interactionCreate.handle(cmdInteraction)
  assert.equal(permReplies.length, 1)
  assert.match(permReplies[0].embeds[0].description, /ウェブフックの管理/)
})

test('/setup via_individual_event allows all 25 defaults when every event logs here, and shows save banner', async (t) => {
  const update = require('../../src/db/interfaces/postgres/update')
  t.mock.method(update, 'setEventsLogId', async () => {})
  const events = require('../../src/bot/events/interactionCreate')
  let round = 0
  t.mock.method(events, 'awaitCustomID', async id => {
    if (round === 0 && id.endsWith(':save')) {
      round++
      return {}
    }
    return new Promise(() => {})
  })
  t.mock.method(events, 'cancelCustomID', () => {})

  const logs = Object.fromEntries(ALL_EVENTS.map(e => [e, 'here']))
  const allPerms = new Proxy({}, { get: () => true })
  global.bot = {
    user: { id: 'bot', dynamicAvatarURL: () => 'a', username: 'b', discriminator: '0' },
    guildSettingsCache: { g1: { getEventLogRaw: () => logs } },
    getChannel: () => ({ permissionsOf: () => ({ json: allPerms }) })
  }
  const shown = []
  const setup = require('../../src/bot/slashcommands/setup')
  await Promise.race([
    setup.func({
      locale: 'ja',
      guildID: 'g1',
      channel: { id: 'here' },
      member: { user: { id: 'u1', dynamicAvatarURL: () => 'a', username: 'u', discriminator: '0' } },
      data: { options: [{ name: 'via_individual_event' }] },
      createMessage: async m => shown.push(m),
      editOriginalMessage: async m => shown.push(m)
    }),
    new Promise(resolve => setTimeout(resolve, 150))
  ])

  const selectMenu = shown[0].components[0].components[0]
  const defaultCount = selectMenu.options.filter(o => o.default).length
  assert.equal(defaultCount, 25)
  assert.ok(selectMenu.max_values >= defaultCount, 'max_values covers all 25 default options')
  assert.match(shown[1].embeds[0].description, /✅ \*\*保存しました\*\*/)
})

test('/setup list groups events by channel with localized labels and shows ignored channels & logbots', async () => {
  const logs = Object.fromEntries(ALL_EVENTS.map(e => [e, 'c-all']))
  global.bot = {
    user: { id: 'bot', avatarURL: 'a', dynamicAvatarURL: () => 'a', username: 'b', discriminator: '0' },
    guildSettingsCache: {
      g1: {
        getEventLogRaw: () => logs,
        ignoredChannels: ['c-ignored'],
        isLogBots: () => true
      }
    }
  }
  const shown = []
  const setup = require('../../src/bot/slashcommands/setup')
  await setup.func({
    locale: 'ja',
    guildID: 'g1',
    channel: { id: 'c1' },
    member: { user: { id: 'u1', avatarURL: 'a', dynamicAvatarURL: () => 'a', username: 'u', discriminator: '0' } },
    data: { options: [{ name: 'list' }] },
    createMessage: async m => shown.push(m)
  })
  const embed = shown[0].embeds[0]
  assert.match(embed.description, /<#c-all> — \*\*すべてのイベント/)
  assert.match(embed.fields[0].value, /<#c-ignored>/)
  assert.match(embed.fields[1].value, /オン/)
})

test('/setup status diagnoses permissions, shows overview, and lets creators toggle per-server AI settings', async (t) => {
  process.env.CREATOR_IDS = 'creator-1'
  const replySettings = require('../../src/db/interfaces/postgres/replySettings')
  const state = {
    replyLength: 'normal',
    streamerPersona: true,
    assistantRules: 'ネタバレ禁止',
    embedMessages: false,
    embedEmojis: false,
    safetyFilter: true,
    uncensoredR18: false,
    debugFooter: false
  }
  t.mock.method(replySettings, 'getReplySettings', async () => state)
  t.mock.method(replySettings, 'setSafety', async (_, __, val) => {
    state.safetyFilter = Boolean(val)
    state.uncensoredR18 = !val
  })
  const events = require('../../src/bot/events/interactionCreate')
  let picked = false
  t.mock.method(events, 'awaitCustomID', async id => {
    if (!picked && id.endsWith(':dev')) {
      picked = true
      return { data: { values: ['safety:relaxed'] } }
    }
    return new Promise(() => {})
  })
  t.mock.method(events, 'cancelCustomID', () => {})

  global.bot = {
    user: { id: 'bot', avatarURL: 'a', dynamicAvatarURL: () => 'a', username: 'b', discriminator: '0' },
    guilds: new Map([['g1', {
      id: 'g1',
      rulesChannelID: 'c-rules',
      roles: new Map(),
      members: new Map([['bot', { permissions: { has: () => false } }]])
    }]]),
    guildSettingsCache: {
      g1: {
        getEventLogRaw: () => ({ messageDelete: 'c-logs', messageUpdate: 'c-logs' }),
        ignoredChannels: [],
        isLogBots: () => false
      }
    },
    getChannel: () => ({
      permissionsOf: () => ({ json: { viewChannel: true, sendMessages: true } })
    })
  }

  const shown = []
  const setup = require('../../src/bot/slashcommands/setup')
  await Promise.race([
    setup.func({
      locale: 'ja',
      guildID: 'g1',
      channel: { id: 'c-here', permissionsOf: () => ({ json: {} }) },
      member: { user: { id: 'creator-1', avatarURL: 'a', dynamicAvatarURL: () => 'a', username: 'dev', discriminator: '0' }, roles: [] },
      data: { options: [{ name: 'status' }] },
      createMessage: async m => shown.push(m),
      editOriginalMessage: async m => shown.push(m)
    }),
    new Promise(resolve => setTimeout(resolve, 150))
  ])

  const firstEmbed = shown[0].embeds[0]
  assert.match(firstEmbed.title, /設定ステータス/)
  assert.equal(firstEmbed.fields.length, 4, 'logging, assistant, permissions, and creator settings')
  assert.match(firstEmbed.fields[0].value, /メッセージ削除、メッセージ編集/)
  assert.match(firstEmbed.fields[1].value, /<#c-rules>/)
  assert.match(firstEmbed.fields[2].value, /ウェブフックの管理/)
  assert.equal(state.safetyFilter, false, 'creator menu toggled safety to relaxed')
  assert.equal(state.uncensoredR18, true)
  assert.match(shown[1].embeds[0].description, /セーフティ・R18設定を更新しました/)
})

test('/help guide:assistant and /invite full-feature link buttons render cleanly', async () => {
  global.bot = { user: { id: '12345', username: 'RoboPolice', discriminator: '0', avatarURL: 'a', dynamicAvatarURL: () => 'a' } }
  const help = require('../../src/bot/slashcommands/help')
  const invite = require('../../src/bot/slashcommands/invite')
  const user = { id: 'u1', username: 'u', discriminator: '0', avatarURL: 'a', dynamicAvatarURL: () => 'a' }

  let helpMsg
  await help.func({
    locale: 'ja',
    data: { options: [{ name: 'guide', value: 'assistant' }] },
    member: { user },
    createMessage: async m => { helpMsg = m }
  })
  assert.equal(helpMsg.embeds[0].title, 'AIメンション・イベント・フォーラムガイド')
  assert.match(helpMsg.embeds[0].description, /予定イベント作成/)

  let inviteMsg
  await invite.func({
    locale: 'ja',
    member: { user },
    createMessage: async m => { inviteMsg = m }
  })
  assert.equal(inviteMsg.embeds[0].fields.length, 3)
  const linkButtons = inviteMsg.components[0].components
  assert.equal(linkButtons.length, 3)
  assert.ok(linkButtons[0].url.includes('permissions=318364830896'))
})
