const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
require('../helpers/fakes')
const Eris = require('eris')
const { langOf, pick } = require('../../src/bot/utils/i18n')
const { commands } = require('../../src/bot/utils/slashcommandconstants')
const { ALL_EVENTS, EVENT_HELP, EVENT_HELP_EN } = require('../../src/bot/utils/constants')

test('a reply is in Japanese for a Japanese client (or when Discord does not say), in English otherwise', () => {
  assert.equal(langOf({ locale: 'ja' }), 'ja')
  assert.equal(langOf({ locale: 'en-US' }), 'en')
  assert.equal(langOf({ locale: 'ko' }), 'en')
  assert.equal(langOf({ guildLocale: 'ja' }), 'ja', 'the server\'s language when the client\'s is missing')
  assert.equal(langOf({}), 'ja')
  assert.equal(pick({ locale: 'en-GB' }, { ja: 'こんにちは', en: 'Hello' }), 'Hello')
  assert.equal(pick({ locale: 'en-GB' }, { ja: 'こんにちは' }), 'こんにちは', 'Japanese when there is no English')
})

test('the language Discord sends is kept on the interaction (Eris drops it)', () => {
  const interaction = Eris.Interaction.from({ type: 2, id: '1', application_id: 'a', token: 't', version: 1, locale: 'en-US', guild_locale: 'ja', data: { id: 'c', name: 'help' } }, { users: { add: u => u }, getChannel: () => null, guilds: { get: () => null } })
  assert.equal(interaction.locale, 'en-US')
  assert.equal(interaction.guildLocale, 'ja')
})

test('every slash command has a handler, and its descriptions and choices in English and Japanese within Discord\'s limits', () => {
  const handlers = fs.readdirSync(path.resolve('src', 'bot', 'slashcommands')).map(f => require(path.resolve('src', 'bot', 'slashcommands', f)).name)
  for (const command of commands) assert.ok(handlers.includes(command.name), command.name)
  for (const gone of ['ping', 'serverinfo', 'userinfo']) assert.ok(!commands.some(c => c.name === gone), `/${gone} is gone`)
  const check = (item, where) => {
    assert.ok(item.description && item.description.length <= 100, `${where}: description`)
    assert.ok(item.description_localizations?.ja && item.description_localizations.ja.length <= 100, `${where}: Japanese description`)
    if (item.choices) assert.ok(item.choices.length <= 25, `${where}: choices`)
    for (const choice of item.choices || []) {
      assert.ok(choice.name.length <= 100 && choice.name_localizations?.ja, `${where}: choice ${choice.value}`)
    }
    for (const option of item.options || []) check(option, `${where} ${option.name}`)
  }
  for (const command of commands) check(command, `/${command.name}`)
})

test('every event is explained in both languages', () => {
  for (const event of ALL_EVENTS) {
    assert.ok(EVENT_HELP[event], event)
    assert.ok(EVENT_HELP_EN[event], event)
  }
})

test('/help answers in the client\'s language', async () => {
  global.bot = { user: { id: 'bot', username: 'RoboPolice', discriminator: '0', dynamicAvatarURL: () => 'a', avatarURL: 'a' } }
  const help = require('../../src/bot/slashcommands/help')
  const ask = async (locale, options) => {
    let sent
    const user = { username: 'u', discriminator: '0', avatarURL: 'a', dynamicAvatarURL: () => 'a' }
    await help.func({ locale, data: { options }, member: { user }, createMessage: async m => { sent = m } })
    return sent.embeds[0]
  }
  assert.equal((await ask('ja')).title, 'ヘルプ')
  assert.equal((await ask('en-US')).title, 'Help')
  assert.equal((await ask('en-US', [{ name: 'guide', value: 'usage' }])).title, 'Usage guide')
  const event = await ask('en-US', [{ name: 'event', value: 'messageDelete' }])
  assert.equal(event.title, 'What messageDelete records')
  assert.ok(event.description.includes(EVENT_HELP_EN.messageDelete))
  assert.ok((await ask('ja', [{ name: 'event', value: 'messageDelete' }])).description.includes(EVENT_HELP.messageDelete))
})

test('/setup assistant shows the assistant\'s settings as menus and saves what is chosen at once', async (t) => {
  const replySettings = require('../../src/db/interfaces/postgres/replySettings')
  const youtubeDB = require('../../src/db/interfaces/postgres/youtube')
  const saved = { persona: true, length: null, live: false }
  t.mock.method(replySettings, 'getReplySettings', async () => ({ replyLength: saved.length, streamerPersona: saved.persona }))
  t.mock.method(replySettings, 'setStreamerPersona', async (_, on) => { saved.persona = on })
  t.mock.method(replySettings, 'setReplyLength', async (_, length) => { saved.length = length })
  t.mock.method(youtubeDB, 'liveEventsOn', async () => saved.live)
  t.mock.method(youtubeDB, 'setLiveEvents', async (_, on) => { saved.live = on })
  const events = require('../../src/bot/events/interactionCreate')
  const answers = [['length', 'short'], ['live', 'on'], ['persona', 'bot']]
  // One choice per message (its menus share an id before the colon).
  const answered = new Set()
  t.mock.method(events, 'awaitCustomID', async id => {
    const [round, which] = id.split(':')
    const next = answers[0]
    if (!next || answered.has(round) || which !== next[0]) return new Promise(() => {})
    answered.add(round)
    answers.shift()
    return { data: { values: [next[1]] } }
  })
  t.mock.method(events, 'cancelCustomID', () => {})
  process.env.YOUTUBE_API_KEY = 'k'
  global.bot = {
    user: { id: 'bot' },
    guilds: { get: () => ({ roles: new Map(), members: { get: () => ({ permissions: { has: () => false } }) } }) }
  }
  const shown = []
  const interaction = {
    locale: 'ja',
    guildID: 'g1',
    member: { user: { id: 'u1' }, roles: [] },
    channel: { permissionsOf: () => ({ json: { manageGuild: true } }) },
    createMessage: async m => shown.push(m),
    editOriginalMessage: async m => shown.push(m)
  }
  const setup = require('../../src/bot/slashcommands/setup')
  try {
    // It waits for the next choice until a minute without one: stopped here once all are made.
    await Promise.race([setup.func({ ...interaction, data: { options: [{ name: 'assistant' }] } }), new Promise(resolve => setTimeout(resolve, 500))])
  } finally {
    delete process.env.YOUTUBE_API_KEY
  }
  const menusOf = m => m.components.map(row => row.components[0])
  const [first] = shown
  assert.equal(first.embeds[0].title, 'AI（メンション）の設定')
  assert.deepEqual(menusOf(first).map(menu => menu.options.find(o => o.default).value), ['streamer', 'long', 'off'], 'the current choices')
  assert.equal(saved.length, 'short', 'saved at once')
  assert.match(shown[2].embeds[0].description, /「イベントの管理」権限がない/, 'no events without Manage Events')
  assert.equal(saved.persona, false)
  assert.deepEqual(menusOf(shown.at(-1)).map(menu => menu.options.find(o => o.default).value), ['bot', 'short', 'off'])
})

test('/setup assistant needs Manage Server', async () => {
  global.bot = { user: { id: 'bot' }, guilds: { get: () => ({ roles: new Map() }) } }
  const said = []
  const setup = require('../../src/bot/slashcommands/setup')
  await setup.func({
    locale: 'en-US',
    guildID: 'g1',
    data: { options: [{ name: 'assistant' }] },
    member: { user: { id: 'u1' }, roles: [] },
    channel: { permissionsOf: () => ({ json: {} }) },
    createMessage: async m => said.push(m)
  })
  assert.equal(said[0].content, 'Changing these settings needs Manage Server.')
})

test('/setup chooses every event to begin with in a channel that logs nothing, and "Save as selected" saves it', async (t) => {
  const update = require('../../src/db/interfaces/postgres/update')
  const saved = []
  t.mock.method(update, 'setEventsLogId', async (guildID, channelID, events) => { saved.push([channelID, events]) })
  const events = require('../../src/bot/events/interactionCreate')
  let round = 0
  t.mock.method(events, 'awaitCustomID', async id => {
    // The first menu: its save button is pressed; after that nothing is chosen.
    if (round === 0 && id.endsWith(':save')) {
      round++
      return {}
    }
    return new Promise(() => {})
  })
  t.mock.method(events, 'cancelCustomID', () => {})
  const { ALL_EVENTS } = require('../../src/bot/utils/constants')
  const logs = Object.fromEntries(ALL_EVENTS.map(e => [e, e === 'messageDelete' ? 'other' : '']))
  const allPerms = new Proxy({}, { get: () => true })
  global.bot = {
    user: { id: 'bot', dynamicAvatarURL: () => 'a', username: 'b', discriminator: '0' },
    guildSettingsCache: { g1: { getEventLogRaw: () => logs } },
    getChannel: () => ({ permissionsOf: () => ({ json: allPerms }) })
  }
  const shown = []
  const interaction = {
    locale: 'ja',
    guildID: 'g1',
    channel: { id: 'here' },
    member: { user: { id: 'u1', dynamicAvatarURL: () => 'a', username: 'u', discriminator: '0' } },
    data: { options: [{ name: 'via_presets' }] },
    createMessage: async m => shown.push(m),
    editOriginalMessage: async m => shown.push(m)
  }
  const setup = require('../../src/bot/slashcommands/setup')
  await Promise.race([setup.func(interaction), new Promise(resolve => setTimeout(resolve, 300))])
  const [menu, buttons] = shown[0].components
  assert.ok(menu.components[0].options.find(o => o.value === 'all').default, 'all, to begin with')
  assert.equal(buttons.components[0].label, 'このまま保存')
  assert.match(shown[0].embeds[0].description, /最初から「すべて」を選んであります/)
  assert.deepEqual(saved[0], ['here', ALL_EVENTS], 'every event saved for this channel')
})
