const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const pool = require('../../src/db/clients/postgres')
// Loaded up front: it installs the real logger as global.logger, which tests then mock.
const batcher = require('../../src/db/messageBatcher')

global.webhook = global.webhook || { generic () {}, warn () {}, error () {} }

describe('messageBatcher', () => {
  test('stores a full batch and its images in one transaction', async (t) => {
    const sent = []
    t.mock.method(pool, 'getPostgresClient', async () => ({ query: async sql => sent.push(sql), release () {} }))
    for (let i = 0; i < 10; i++) await batcher.addItem([`m${i}`, '1', 'hi', i === 3 ? ['https://cdn/a.png', 'https://cdn/b.png'] : [], '2026-10-29T00:00:00.000Z', '201', '100'])
    assert.equal(sent[0], 'BEGIN')
    assert.match(sent[1], /^INSERT INTO messages \(id, author_id, content, ts, channel_id, guild_id\)\s+SELECT .* FROM \(VALUES \('m0', '1', 'hi', '2026-10-29T00:00:00.000Z', '201', '100'\), /s)
    assert.equal((sent[1].match(/\('m\d'/g) || []).length, 10, 'no message lost')
    assert.match(sent[2], /^INSERT INTO message_attachments \(message_id, position, url\)\s+SELECT .* FROM \(VALUES \('m3', '0', 'https:\/\/cdn\/a.png'\), \('m3', '1', 'https:\/\/cdn\/b.png'\)\)/s)
    assert.equal(sent[3], 'COMMIT')
  })

  test('deleting a message still waiting in memory removes it before it is stored', async (t) => {
    t.mock.method(pool, 'query', async () => ({ rows: [] }))
    const { deleteMessage } = require('../../src/db/interfaces/postgres/delete')
    await batcher.addItem(['secret', '1', 'すぐ消した発言', [], '2026-10-29T00:00:00.000Z', '301', '100'])
    assert.equal(batcher.getMessage('secret').content, 'すぐ消した発言')
    await deleteMessage('secret')
    assert.equal(batcher.getMessage('secret'), undefined)
    assert.deepEqual(batcher.getChannelMessages('301'), [])
  })
})
