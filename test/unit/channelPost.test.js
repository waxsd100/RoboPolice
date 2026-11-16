const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { canPostAsBot, toChannelPost, NO_POST_PERMISSION } = require('../../src/bot/modules/channelPost')
const { createGuild, createMember, installBot } = require('../helpers/fakes')

const guild = createGuild({
  ownerID: '900',
  channels: [
    { id: '401', name: 'お知らせ', type: 5, posters: ['1', '900', 'BOT'] },
    { id: '402', name: 'BOT不可', type: 0, posters: ['1'] },
    { id: '403', name: '募集', type: 15, posters: ['1', 'BOT'] },
    { id: '404', name: 'ボイス', type: 2, posters: ['1', 'BOT'] }
  ]
})
guild.roles.set('700', { id: '700', name: 'スタッフ', position: 5 })
guild.roles.set('701', { id: '701', name: '上位', position: 9 })
guild.roles.set('702', { id: '702', name: '一般', position: 1 })

describe('canPostAsBot: moderators and above only', () => {
  let staffRole
  beforeEach(() => {
    staffRole = process.env.STAFF_ROLE_ID
    process.env.STAFF_ROLE_ID = '700'
  })
  afterEach(() => {
    if (staffRole === undefined) delete process.env.STAFF_ROLE_ID
    else process.env.STAFF_ROLE_ID = staffRole
  })

  for (const permission of ['manageMessages', 'moderateMembers', 'kickMembers', 'banMembers', 'manageGuild', 'administrator']) {
    test(`${permission} counts as a moderator`, () => {
      assert.equal(canPostAsBot(createMember({ id: '1', permissions: [permission] }), guild), true)
    })
  }

  test('the owner, and a role at or above STAFF_ROLE_ID, count without permissions', () => {
    assert.equal(canPostAsBot(createMember({ id: '900', permissions: [] }), guild), true)
    assert.equal(canPostAsBot(createMember({ id: '1', permissions: [], roles: ['701'] }), guild), true)
  })

  test('Manage Events, Send Messages or a low role is not enough', () => {
    assert.equal(canPostAsBot(createMember({ id: '1', permissions: ['manageEvents', 'sendMessages'], roles: ['702'] }), guild), false)
    assert.equal(canPostAsBot(null, guild), false)
  })
})

describe('toChannelPost', () => {
  beforeEach(() => installBot({ guilds: [guild] }))
  const mod = createMember({ id: '1', permissions: ['manageMessages'] })

  test('a text or announcement channel both can write in becomes a message with mentions off', () => {
    const result = toChannelPost({ found: true, channel_id: '<#401>', content: '  @everyone 配信します  ' }, guild, mod)
    assert.deepEqual(result.message, { channelID: '401', content: '@everyone 配信します', allowed_mentions: { parse: [] } })
    assert.equal(result.truncated, false)
  })

  test('refuses below moderator before anything else', () => {
    const result = toChannelPost({ found: true, channel_id: '401', content: 'x' }, guild, createMember({ id: '1' }))
    assert.equal(result.error, NO_POST_PERMISSION)
  })

  test('refuses forums, voice channels, unknown channels and channels the bot cannot write in', () => {
    for (const id of ['403', '404', '999']) {
      assert.equal(toChannelPost({ found: true, channel_id: id, content: 'x' }, guild, mod).error, '書き込み先のテキストチャンネルが見つかりませんでした。')
    }
    assert.equal(toChannelPost({ found: true, channel_id: '402', content: 'x' }, guild, mod).error, 'BOTが <#402> に書き込む権限を持っていません。')
  })

  test('keeps the channel of a message being edited, and long text is cut to 2000 characters', () => {
    const result = toChannelPost({ found: true, channel_id: '402', content: 'あ'.repeat(2100) }, guild, mod, { keepChannel: '401' })
    assert.equal(result.message.channelID, '401')
    assert.equal(result.message.content.length, 2000)
    assert.equal(result.truncated, true)
  })

  test('found: false and an empty body are reasons, not messages', () => {
    assert.equal(toChannelPost({ found: false, reason: '書き込み先が分かりません' }, guild, mod).error, '書き込み先が分かりません')
    assert.equal(toChannelPost({ found: true, channel_id: '401', content: ' ' }, guild, mod).error, '書き込む本文を決められませんでした。')
  })
})
