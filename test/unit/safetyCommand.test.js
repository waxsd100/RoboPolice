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

  test('shows defaults: owner servers have filter off; other servers have filter on', async () => {
    const owner = await run('100')
    assert.match(owner.sent[0].content, /Gemini セーフティフィルタ \(`filter`\): オフ（既定：オーナーサーバーのためオフ）/)

    const other = await run('200')
    assert.match(other.sent[0].content, /Gemini セーフティフィルタ \(`filter`\): オン（既定：オン）/)
  })

  test('toggles safety filter per server', async () => {
    await run('200', 'off')
    let got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, false)

    await run('200', 'on')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, true)

    await run('200', 'filter off')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, false)

    await run('200', 'default')
    got = await store.getReplySettings('200')
    assert.equal(got.safetyFilter, true)
  })

  test('rejects invalid arguments and shows usage', async () => {
    const res = await run('200', 'invalid on')
    assert.match(res.sent[0].content, /`on`・`off`・`default` を指定してください。/)
  })
})
