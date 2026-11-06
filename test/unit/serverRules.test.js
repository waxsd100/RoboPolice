const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { installReplyLengthStore } = require('../helpers/fakes')
const serverRules = require('../../src/bot/modules/serverRules')

const guildWith = (channels, rulesChannelID) => ({ id: 'g1', rulesChannelID, channels: new Map(channels.map(c => [c.id, c])) })

beforeEach(() => serverRules.reset())

test('the rules channel is the one set in Discord, else one named like it', () => {
  const channels = [{ id: '1', name: 'general', type: 0 }, { id: '2', name: '📜ルール', type: 0 }, { id: '3', name: 'server-rules', type: 2 }]
  assert.equal(serverRules.rulesChannel(guildWith(channels, '1')).id, '1')
  assert.equal(serverRules.rulesChannel(guildWith(channels)).id, '2')
  assert.equal(serverRules.rulesChannel(guildWith([{ id: '1', name: 'general', type: 0 }])), null)
})

test('its messages are read oldest first with their embeds, kept for an hour', async () => {
  const guild = guildWith([{ id: '2', name: 'rules', type: 0 }])
  let reads = 0
  const getMessages = async (id, { limit }) => {
    reads++
    assert.equal(id, '2')
    assert.equal(limit, 20)
    return [
      { timestamp: 2, content: '2. ネタバレ禁止', embeds: [] },
      { timestamp: 1, content: '', embeds: [{ title: 'ルール', description: '1. 仲良く', fields: [{ name: '罰則', value: 'BAN' }] }] }
    ]
  }
  const rules = await serverRules.readRules(guild, { getMessages, now: 0 })
  assert.deepEqual(rules.text, 'ルール\n1. 仲良く\n罰則\nBAN\n\n2. ネタバレ禁止')
  await serverRules.readRules(guild, { getMessages, now: 30 * 60 * 1000 })
  assert.equal(reads, 1, 'kept')
  await serverRules.readRules(guild, { getMessages, now: 61 * 60 * 1000 })
  assert.equal(reads, 2, 'read again after an hour')
  const long = await serverRules.readRules(guildWith([{ id: '2', name: 'rules', type: 0 }]), { getMessages: async () => [{ timestamp: 1, content: 'あ'.repeat(5000) }], now: 10 * 60 * 60 * 1000 })
  assert.equal(long.text.length, serverRules.MAX_RULES_CHARS + 1)
  assert.equal(await serverRules.readRules(guildWith([])), null)
  serverRules.reset()
  assert.equal(await serverRules.readRules(guild, { getMessages: async () => { throw new Error('Missing Access') } }), null, 'unreadable: none')
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
