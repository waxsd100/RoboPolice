const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createGuild, installReplyLengthStore } = require('../helpers/fakes')
const store = require('../../src/db/interfaces/postgres/replySettings')
const emojiDescriber = require('../../src/bot/modules/emojiDescriber')
const command = require('../../src/bot/commands/embeddings')

describe('%embeddings command', () => {
  beforeEach(() => {
    installReplyLengthStore()
    process.env.GLOBAL_BOT_PREFIX = '%'
    process.env.OWNER_GUILD_IDS = '100'
  })
  afterEach(() => {
    delete process.env.OWNER_GUILD_IDS
  })

  function run (guildID, suffix = '') {
    const guild = createGuild({ id: guildID })
    const sent = []
    const message = {
      id: '1',
      channel: { id: '201', guild, createMessage: async body => { sent.push(body) } }
    }
    return command.func(message, suffix).then(() => ({ sent, guild }))
  }

  test('shows defaults: owner servers on, other servers off', async () => {
    const owner = await run('100')
    assert.match(owner.sent[0].content, /メッセージのベクトル化 \(`messages`\): オン（既定：オーナーサーバーのためオン）/)
    assert.match(owner.sent[0].content, /絵文字の説明・ベクトル化 \(`emojis`\): オン（既定：オーナーサーバーのためオン）/)

    const other = await run('200')
    assert.match(other.sent[0].content, /メッセージのベクトル化 \(`messages`\): オフ（既定：オフ）/)
    assert.match(other.sent[0].content, /絵文字の説明・ベクトル化 \(`emojis`\): オフ（既定：オフ）/)
  })

  test('toggles both or each individually, and schedules emoji sync when emojis are enabled', async (t) => {
    const scheduled = []
    t.mock.method(emojiDescriber, 'schedule', guild => scheduled.push(guild.id))

    const r1 = await run('200', 'messages on')
    assert.match(r1.sent[0].content, /変更しました。/)
    assert.equal(await store.isEmbedMessagesEnabled('200'), true)
    assert.equal(await store.isEmbedEmojisEnabled('200'), false)
    assert.deepEqual(scheduled, [], 'messages only: emoji sync not scheduled')

    const r2 = await run('200', 'emojis on')
    assert.match(r2.sent[0].content, /絵文字の説明・ベクトル化 \(`emojis`\): オン（このサーバーの設定）/)
    assert.equal(await store.isEmbedEmojisEnabled('200'), true)
    assert.deepEqual(scheduled, ['200'])

    await run('200', 'off')
    assert.equal(await store.isEmbedMessagesEnabled('200'), false)
    assert.equal(await store.isEmbedEmojisEnabled('200'), false)

    await run('200', 'on')
    assert.equal(await store.isEmbedMessagesEnabled('200'), true)
    assert.equal(await store.isEmbedEmojisEnabled('200'), true)
    assert.deepEqual(scheduled, ['200', '200'])

    await run('100', 'off')
    assert.equal(await store.isEmbedMessagesEnabled('100'), false)
    assert.equal(await store.isEmbedEmojisEnabled('100'), false)

    await run('100', 'default')
    assert.equal(await store.isEmbedMessagesEnabled('100'), true)
    assert.equal(await store.isEmbedEmojisEnabled('100'), true)
  })

  test('rejects invalid arguments and shows usage', async () => {
    const res = await run('200', 'videos on')
    assert.match(res.sent[0].content, /`messages` \/ `emojis`（または省略）と `on`・`off`・`default` を指定してください。/)
  })
})
