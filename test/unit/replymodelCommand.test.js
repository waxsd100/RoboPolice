const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installReplyLengthStore } = require('../helpers/fakes')
const command = require('../../src/bot/commands/replymodel')

function run (suffix) {
  const said = []
  const message = { id: 'm', channel: { guild: { id: 'g1' }, createMessage: async m => said.push(m.content) } }
  return command.func(message, suffix).then(() => said[0])
}

test('%replymodel shows, sets and resets the server\'s model, thinking level and tier across all 6 tasks; only for the bot\'s developers', async () => {
  const { models } = installReplyLengthStore()
  const { resolveTaskConfig } = require('../../src/bot/modules/eventDrafter')
  try {
    assert.equal(command.type, 'creator')
    const initial = await run('')
    assert.match(initial, /- モデル: gemini-3\.8-flash（既定）\n- 思考の深さ: high（既定）\n- 推論ティア: standard（既定）/)
    assert.match(initial, /- `rules`（初回メンション時のルール選定）: gemini-3\.1-flash-lite（既定） \/ 思考:minimal（既定） \/ ティア:standard（既定）/)
    assert.match(initial, /- `blurb`（配信開始前のイベント告知文・ゲームURL）: gemini-3\.5-flash-lite（既定） \/ 思考:low（既定） \/ ティア:standard（既定）/)
    assert.match(initial, /- `light`（絵文字説明・定期Web検索）: gemini-3\.5-flash-lite（既定） \/ 思考:low（既定） \/ ティア:flex（既定）/)
    assert.match(initial, /- `extract`（Wiki \/ X \/ Steam \/ Web 知識抽出・内輪ネタ抽出）: gemini-3\.1-flash-lite（既定） \/ 思考:minimal（既定） \/ ティア:flex（既定）/)
    assert.match(initial, /- `summary`（配信アーカイブ自動要約）: gemini-3\.8-flash（既定） \/ 思考:low（既定） \/ ティア:flex（既定）/)
    assert.match(await run('model gemini-4-argon'), /- モデル: gemini-4-argon（このサーバーの設定）/)
    assert.match(await run('thinking low'), /- 思考の深さ: low（このサーバーの設定）/)
    assert.deepEqual(models.g1, { model: 'gemini-4-argon', thinking: 'low' })
    assert.match(await run('tier flex'), /- 推論ティア: flex（このサーバーの設定）/)
    assert.match(await run('extract model gemini-3.5-flash-lite'), /- `extract`（Wiki \/ X \/ Steam \/ Web 知識抽出・内輪ネタ抽出）: gemini-3\.5-flash-lite（設定） \/ 思考:minimal（既定） \/ ティア:flex（既定）/)
    assert.match(await run('extract thinking low'), /思考:low（設定）/)
    assert.match(await run('extract tier standard'), /ティア:standard（設定）/)
    assert.deepEqual(await resolveTaskConfig('extract', 'g1'), {
      model: 'gemini-3.5-flash-lite',
      thinking: { thinkingConfig: { thinkingLevel: 'low' } },
      tier: 'standard',
      flex: false
    })
    assert.match(await run('extract default'), /- `extract`（Wiki \/ X \/ Steam \/ Web 知識抽出・内輪ネタ抽出）: gemini-3\.1-flash-lite（既定） \/ 思考:minimal（既定） \/ ティア:flex（既定）/)
    assert.deepEqual(await resolveTaskConfig('extract', 'g1'), {
      model: 'gemini-3.1-flash-lite',
      thinking: { thinkingConfig: { thinkingLevel: 'minimal' } },
      tier: 'flex',
      flex: true
    })
    assert.match(await run('model gemini-3.1-flash-image'), /`default` を指定してください/, 'not an image model')
    assert.match(await run('model gpt-5'), /`default` を指定してください/)
    assert.match(await run('thinking extreme'), /`minimal`・`low`・`medium`・`high` か `default`/)
    assert.match(await run('tier batch'), /`standard`・`flex` か `default`/)
    assert.match(await run('model default'), /- モデル: gemini-3\.8-flash（既定）/)
    assert.equal(models.g1.model, null)
    assert.match(await run('speed fast'), /`model` か `thinking` を指定してください/)
  } finally {
    installReplyLengthStore()
  }
})

test('every reply model has a price, is not an image model, and the reply lengths match the prompt\'s', () => {
  const { REPLY_MODELS, REPLY_LENGTH_CHOICES } = require('../../src/bot/utils/replyOptions')
  const { PRICES } = require('../../src/bot/utils/geminiPrices')
  const { REPLY_LENGTHS } = require('../../src/bot/modules/eventDrafter')
  for (const model of REPLY_MODELS) {
    const price = PRICES.find(p => p.model === model)
    assert.ok(price, model)
    assert.equal(price.imageOutput, undefined, model)
  }
  assert.deepEqual(Object.keys(REPLY_LENGTHS), REPLY_LENGTH_CHOICES)
})
