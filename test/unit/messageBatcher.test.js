// When the channel columns cannot be added, messages must still be stored as before, not lost.
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const pool = require('../../src/db/clients/postgres')
const aes = require('../../src/db/aes')
// Loaded up front: it installs the real logger as global.logger, which tests then mock.
const batcher = require('../../src/db/messageBatcher')

global.webhook = global.webhook || { generic () {}, warn () {}, error () {} }

describe('messageBatcher without the channel columns', () => {
  test('falls back to the old insert and keeps every message', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    t.mock.method(pool, 'query', async sql => {
      if (sql.startsWith('ALTER')) throw new Error('must be owner of table messages')
      return { rows: [] }
    })
    const inserted = []
    t.mock.method(pool, 'getPostgresClient', async () => ({ query: async sql => inserted.push(sql), release () {} }))
    for (let i = 0; i < 10; i++) await batcher.addItem([`m${i}`, '1', aes.encrypt('hi'), '', '2026-10-29T00:00:00.000Z', '201', '100'])
    assert.equal(inserted.length, 1)
    assert.match(inserted[0], /^INSERT INTO messages \(id, author_id, content, attachment_b64, ts\) VALUES \('m0', '1', '[^']+', '', '2026-10-29T00:00:00.000Z'\), /)
    assert.equal((inserted[0].match(/\('m\d'/g) || []).length, 10, 'no message lost')
    assert.match(warned.mock.calls[0].arguments[0], /Storing messages without their channel: must be owner of table messages/)
  })

  test('deleting a message still waiting in memory removes it before it is stored', async (t) => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }))
    const { deleteMessage } = require('../../src/db/interfaces/postgres/delete')
    await batcher.addItem(['secret', '1', aes.encrypt('すぐ消した発言'), '', '2026-10-29T00:00:00.000Z', '301', '100'])
    assert.equal(batcher.getMessage('secret').content, 'すぐ消した発言')
    await deleteMessage('secret')
    assert.equal(batcher.getMessage('secret'), undefined)
    assert.deepEqual(batcher.getChannelMessages('301'), [])
  })
})
