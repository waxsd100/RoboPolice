const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installReplyLengthStore } = require('../helpers/fakes')
const command = require('../../src/bot/commands/tokenlimit')

function run (suffix) {
  const said = []
  const message = { id: 'm', channel: { guild: { id: 'g1' }, createMessage: async m => said.push(m.content) } }
  return command.func(message, suffix).then(() => said[0])
}

test('%tokenlimit shows, sets and resets the server\'s own limits; only for the bot\'s developers', async () => {
  const { tokenLimits } = installReplyLengthStore()
  try {
    assert.equal(command.type, 'creator')
    assert.match(await run(''), /5時間あたり: 150,000 トークン（既定）\n- 1週間あたり: 750,000 トークン（既定）\n- 低速モード（Flex）に切り替える目安: 上限の 80%（既定）/)
    assert.match(await run('5h 300,000'), /5時間あたり: 300,000 トークン（このサーバーの設定）/)
    assert.equal(tokenLimits.g1['5h'], 300000)
    assert.match(await run('week 0'), /1週間あたり: 上限なし（このサーバーの設定）/)
    assert.match(await run('flex 0'), /切り替える目安: しない（このサーバーの設定）/)
    assert.match(await run('flex 101'), /0〜100 の整数/)
    assert.match(await run('5h -1'), /0 以上の整数/)
    assert.match(await run('day 1'), /`5h`・`week`・`flex` のどれか/)
    assert.match(await run('5h default'), /5時間あたり: 150,000 トークン（既定）/)
    assert.equal(tokenLimits.g1['5h'], null)
  } finally {
    installReplyLengthStore()
  }
})
