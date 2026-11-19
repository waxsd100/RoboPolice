const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const aiCache = require('../../src/bot/utils/aiCache')

describe('aiCache', () => {
  const originalStore = { ...aiCache.store }

  afterEach(() => {
    Object.assign(aiCache.store, originalStore)
    delete process.env.REDIS_OP_TIMEOUT_MS
  })

  test('fails open quickly when Redis operations hang instead of blocking callers forever', async () => {
    process.env.REDIS_OP_TIMEOUT_MS = '30'
    const hang = () => new Promise(() => {})
    aiCache.store.get = hang
    aiCache.store.mget = hang
    aiCache.store.set = hang
    aiCache.store.mset = hang
    aiCache.store.setnx = hang
    aiCache.store.del = hang

    const started = Date.now()
    assert.equal(await aiCache.get('k'), null)
    assert.equal(await aiCache.getJson('k'), null)
    assert.deepEqual(await aiCache.mget(['a', 'b']), [null, null])
    assert.equal(await aiCache.set('k', 'v', 60), false)
    await aiCache.mset([['a', '1']], 60)
    assert.equal(await aiCache.setnx('k', '1', 60), true)
    await aiCache.del('k')
    assert.ok(Date.now() - started < 1000, 'all hung operations timed out promptly')
  })
})
