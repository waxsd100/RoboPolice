const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { installReplyLengthStore } = require('../helpers/fakes')
const serverRules = require('../../src/bot/modules/serverRules')

const guildWith = (channels, rulesChannelID) => ({ id: 'g1', rulesChannelID, channels: new Map(channels.map(c => [c.id, c])) })

beforeEach(() => serverRules.reset())

test('the rules channels: the one set in Discord first, then those the model picks by name and topic; kept until the channels change', async t => {
  const drafter = require('../../src/bot/modules/eventDrafter')
  t.mock.method(drafter, 'isConfigured', () => true)
  const asked = []
  t.mock.method(drafter, 'callGemini', async (model, body, options) => {
    asked.push({ model, text: body.contents[0].parts[0].text, thinking: body.generationConfig.thinkingConfig?.thinkingLevel, purpose: options.purpose, flex: options.flex })
    return { parts: [{ text: '300000000000000003, 999999999999999999, 300000000000000002' }] }
  })
  const channels = [
    { id: '300000000000000001', name: 'general', type: 0 },
    { id: '300000000000000002', name: '📌はじめに', type: 0, topic: '最初に読んでね' },
    { id: '300000000000000003', name: '必読', type: 5 },
    { id: '300000000000000004', name: 'vc', type: 2 }
  ]
  const guild = guildWith(channels, '300000000000000001')
  const picked = await serverRules.rulesChannels(guild, { pick: serverRules.askModel })
  assert.deepEqual(picked.map(c => c.id), ['300000000000000001', '300000000000000003', '300000000000000002'], 'Discord\'s own first; an ID not in the server is dropped')
  assert.equal(asked[0].model, 'gemini-3.1-flash-lite')
  assert.equal(asked[0].thinking, 'minimal')
  assert.equal(asked[0].purpose, 'serverRules')
  assert.equal(asked[0].flex, undefined, 'runs on Standard tier so mention replies do not wait on Flex')
  assert.match(asked[0].text, /300000000000000002: #📌はじめに — 最初に読んでね/)
  assert.doesNotMatch(asked[0].text, /#vc/, 'voice channels are not offered')
  await serverRules.rulesChannels(guild, { pick: serverRules.askModel })
  assert.equal(asked.length, 1, 'kept')
  serverRules.reset({ memoryOnly: true })
  await serverRules.rulesChannels(guild, { pick: serverRules.askModel })
  assert.equal(asked.length, 1, 'reused from Redis across worker restarts')
  channels.push({ id: '300000000000000005', name: 'new', type: 0 })
  const changed = guildWith(channels, '300000000000000001')
  await serverRules.rulesChannels(changed, { pick: serverRules.askModel })
  assert.equal(asked.length, 2, 'picked again when the channels change')
})

test('without Gemini, or when the pick fails, channels named like rules are taken (and the pick is tried again later)', async t => {
  const drafter = require('../../src/bot/modules/eventDrafter')
  const channels = [{ id: '1', name: 'general', type: 0 }, { id: '2', name: '📜ルール', type: 0 }, { id: '3', name: 'server-rules', type: 2 }]
  t.mock.method(drafter, 'isConfigured', () => false)
  assert.deepEqual((await serverRules.rulesChannels(guildWith(channels))).map(c => c.id), ['2'])
  serverRules.reset()
  t.mock.method(drafter, 'isConfigured', () => true)
  let tries = 0
  const failing = async () => { tries++; throw new Error('HTTP 503') }
  assert.deepEqual((await serverRules.rulesChannels(guildWith(channels), { pick: failing, now: 0 })).map(c => c.id), ['2'])
  await serverRules.rulesChannels(guildWith(channels), { pick: failing, now: 10 * 60 * 1000 })
  assert.equal(tries, 1, 'not at once')
  await serverRules.rulesChannels(guildWith(channels), { pick: failing, now: 61 * 60 * 1000 })
  assert.equal(tries, 2, 'again an hour later')
})

test('the channels are read oldest first with their embeds, together up to the limit, kept for an hour', async () => {
  const guild = guildWith([{ id: '2', name: 'rules', type: 0 }, { id: '3', name: '必読', type: 0 }])
  const byName = async (g, channels) => serverRules.byName(channels)
  let reads = 0
  const getMessages = async (id, { limit }) => {
    reads++
    assert.equal(limit, 20)
    if (id === '3') return [{ timestamp: 1, content: '3. 宣伝禁止' }]
    return [
      { timestamp: 2, content: '2. ネタバレ禁止', embeds: [] },
      { timestamp: 1, content: '', embeds: [{ title: 'ルール', description: '1. 仲良く', fields: [{ name: '罰則', value: 'BAN' }] }] }
    ]
  }
  const rules = await serverRules.readRules(guild, { getMessages, now: 0, pick: byName })
  assert.deepEqual(rules, [{ channelID: '2', text: 'ルール\n1. 仲良く\n罰則\nBAN\n\n2. ネタバレ禁止' }, { channelID: '3', text: '3. 宣伝禁止' }])
  await serverRules.readRules(guild, { getMessages, now: 30 * 60 * 1000, pick: byName })
  assert.equal(reads, 2, 'kept')
  await serverRules.readRules(guild, { getMessages, now: 61 * 60 * 1000, pick: byName })
  assert.equal(reads, 4, 'read again after an hour')
  serverRules.reset()
  const long = await serverRules.readRules(guild, { getMessages: async () => [{ timestamp: 1, content: 'あ'.repeat(5000) }], pick: byName })
  assert.equal(long.length, 1, 'the limit is for all of them')
  assert.equal(long[0].text.length, serverRules.MAX_RULES_CHARS + 1)
  assert.equal(await serverRules.readRules(guildWith([]), { pick: byName }), null)
  serverRules.reset()
  assert.equal(await serverRules.readRules(guild, { getMessages: async () => { throw new Error('Missing Access') }, pick: byName }), null, 'unreadable: none')
})

test('/assistantrules shows, sets and clears what the moderators ask; needs Manage Server', async () => {
  const { rules } = installReplyLengthStore()
  const command = require('../../src/bot/slashcommands/assistantrules')
  assert.deepEqual(command.userPerms, ['manageGuild'])
  global.bot = { guilds: { get: () => guildWith([{ id: '9', name: 'ルール', type: 0 }]) } }
  const run = async (options, locale = 'ja') => {
    let said
    await command.func({ locale, guildID: 'g1', data: { options }, createMessage: async m => { said = m } })
    return said.content
  }
  try {
    assert.match(await run([]), /なし（`\/assistantrules text:` で設定できます）\n\nサーバーのルールは <#9> から読んで/)
    assert.match(await run([{ name: 'text', value: '  政治の話はしない ' }]), /^保存しました。[\s\S]*>>> 政治の話はしない$/)
    assert.equal(rules.g1, '政治の話はしない')
    assert.match(await run([], 'en-US'), /What the moderators ask of the assistant\*\*\n>>> 政治の話はしない/)
    assert.match(await run([{ name: 'text', value: 'あ'.repeat(2001) }]), /2000 文字まで/)
    assert.equal(await run([{ name: 'clear', value: true }]), 'AI へのお願いを消しました。')
    assert.equal(rules.g1, null)
  } finally {
    installReplyLengthStore()
  }
})
