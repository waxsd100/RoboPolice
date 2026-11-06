const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installReplyLengthStore } = require('../helpers/fakes')
const command = require('../../src/bot/commands/replymodel')

function run (suffix) {
  const said = []
  const message = { id: 'm', channel: { guild: { id: 'g1' }, createMessage: async m => said.push(m.content) } }
  return command.func(message, suffix).then(() => said[0])
}

test('%replymodel shows, sets and resets the server\'s model and thinking level; only for the bot\'s developers', async () => {
  const { models } = installReplyLengthStore()
  try {
    assert.equal(command.type, 'creator')
    assert.match(await run(''), /- モデル: gemini-3\.8-flash（既定）\n- 思考の深さ: high（既定）/)
    assert.match(await run('model gemini-4-argon'), /- モデル: gemini-4-argon（このサーバーの設定）/)
    assert.match(await run('thinking low'), /- 思考の深さ: low（このサーバーの設定）/)
    assert.deepEqual(models.g1, { model: 'gemini-4-argon', thinking: 'low' })
    assert.match(await run('model gemini-3.1-flash-image'), /`default` を指定してください/, 'not an image model')
    assert.match(await run('model gpt-5'), /`default` を指定してください/)
    assert.match(await run('thinking extreme'), /`minimal`・`low`・`medium`・`high` か `default`/)
    assert.match(await run('model default'), /- モデル: gemini-3\.8-flash（既定）/)
    assert.equal(models.g1.model, null)
    assert.match(await run('speed fast'), /`model` か `thinking` を指定してください/)
  } finally {
    installReplyLengthStore()
  }
})
