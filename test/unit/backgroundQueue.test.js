const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const queue = require('../../src/bot/utils/backgroundQueue')
const { ownerFirst, isOwnerGuild } = require('../../src/bot/utils/priority')

const OWNER = '615170683068219393'
afterEach(() => { delete process.env.AI_BACKGROUND_CONCURRENCY })

test('the owner\'s servers (and work for no server) go before every other server, a few at a time', async () => {
  process.env.AI_BACKGROUND_CONCURRENCY = '1'
  const order = []
  let release
  const first = queue.run('other1', () => new Promise(resolve => { release = resolve; order.push('other1') }))
  const jobs = [
    queue.run('other2', async () => order.push('other2')),
    queue.run(OWNER, async () => order.push('owner')),
    queue.run(null, async () => order.push('none')),
    queue.run('other3', async () => order.push('other3'))
  ]
  assert.deepEqual(queue.waiting(), { active: 1, high: 2, low: 2 })
  await new Promise(resolve => setImmediate(resolve))
  release()
  await Promise.all([first, ...jobs])
  assert.deepEqual(order, ['other1', 'owner', 'none', 'other2', 'other3'])
})

test('work that waits too long for its turn is given up', async () => {
  process.env.AI_BACKGROUND_CONCURRENCY = '1'
  let release
  const busy = queue.run(OWNER, () => new Promise(resolve => { release = resolve }))
  await assert.rejects(queue.run('other', async () => 'late', { maxWaitMs: 20 }), queue.QueueTimeout)
  await new Promise(resolve => setImmediate(resolve))
  release()
  await busy
  assert.equal(await queue.run('other', async () => 'now', { maxWaitMs: 20 }), 'now')
})

test('a failing job does not stop the queue', async () => {
  await assert.rejects(queue.run('x', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await queue.run('x', async () => 1), 1)
})

test('ownerFirst keeps the order otherwise', () => {
  assert.equal(isOwnerGuild(OWNER), true)
  assert.deepEqual(ownerFirst(['a', OWNER, 'b']), [OWNER, 'a', 'b'])
  assert.deepEqual(ownerFirst([{ g: 'a' }, { g: OWNER }], x => x.g).map(x => x.g), [OWNER, 'a'])
})
