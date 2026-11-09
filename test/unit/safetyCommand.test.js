const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createGuild, installReplyLengthStore } = require('../helpers/fakes')
const store = require('../../src/db/interfaces/postgres/replySettings')
const command = require('../../src/bot/commands/safety')

describe('%safety command', () => {
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

  test('shows defaults: owner servers have filter off and R18 on; other servers have filter on and R18 off', async () => {
    const owner = await run('100')
    assert.match(owner.sent[0].content, /Gemini セーフティフィルタ \(`filter`\): オフ（既定：オーナーサーバーのためオフ）/)
    assert.match(owner.sent[0].content, /R18・検閲なしモデル引き継ぎ \(`r18`\): オン（既定：オーナーサーバーのためオン）/)

    const other = await run('200')
    assert.match(other.sent[0].content, /Gemini セーフティフィルタ \(`filter`\): オン（既定：オン）/)
    assert.match(other.sent[0].content, /R18・検閲なしモデル引き継ぎ \(`r18`\): オフ（既定：オフ）/)
  })

  test('toggles filter and r18 separately or together', async () => {
    await run('200', 'filter off')
    let got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, false)
    assert.equal(got.uncensoredR18, false, 'r18 stays off when only filter is changed')

    await run('200', 'r18 on')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, false)
    assert.equal(got.uncensoredR18, true)

    await run('200', 'on')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, true)
    assert.equal(got.uncensoredR18, false)

    await run('200', 'off')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, false)
    assert.equal(got.uncensoredR18, true)

    await run('200', 'default')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, true)
    assert.equal(got.uncensoredR18, false)
  })

  test('rejects invalid arguments and shows usage', async () => {
    const res = await run('200', 'invalid on')
    assert.match(res.sent[0].content, /`filter` \/ `r18`（または省略）と `on`・`off`・`default` を指定してください。/)
  })
})
