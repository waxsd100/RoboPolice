// Filling in the channel of messages stored before channels were recorded, from a fake Discord.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const database = require('./database')
require('../helpers/fakes')
const { backfill, discordClient, snowflakeAt } = require('../../src/miscellaneous/backfillChannels')

describe('backfillChannels', { skip: !database.available && 'needs PGHOST' }, () => {
  let pool
  const q = async (sql, args) => (await pool.query(sql, args)).rows
  // A message ID sent at `iso`, plus `n` so IDs at the same time differ.
  const idAt = (iso, n = 0) => (BigInt(snowflakeAt(iso)) + BigInt(n)).toString()

  before(async () => {
    await database.create()
    pool = require('../../src/db/clients/postgres')
    await require('../../src/db/migrate').migrate()
    await q("INSERT INTO guilds (id, owner_id) VALUES ('g1', 'o1')")
  })
  after(() => database.drop())

  test('finds each message in its channel or thread and leaves the rest', async () => {
    const general = Array.from({ length: 150 }, (_, i) => idAt('2026-01-01T00:00:00Z', i))
    const inThread = idAt('2026-02-01T00:00:00Z')
    const gone = idAt('2026-03-01T00:00:00Z')
    const known = idAt('2026-04-01T00:00:00Z')
    for (const [id, ts] of [[general[3], '2026-01-01'], [general[140], '2026-01-01'], [inThread, '2026-02-01'], [gone, '2026-03-01']]) {
      await q('INSERT INTO messages (id, author_id, content, ts, embedded) VALUES ($1, $2, $3, $4, true)', [id, 'u', 'x', ts])
    }
    await q("INSERT INTO messages (id, author_id, content, ts, channel_id, guild_id, embedded) VALUES ($1, 'u', 'x', '2026-04-01', 'c9', 'g1', true)", [known])

    // Newest first, 100 a page, as Discord answers.
    const history = { c1: [...general].reverse(), t1: [inThread], v1: [] }
    const requests = []
    const fetchImpl = async url => {
      const path = url.replace('https://discord.com/api/v10', '')
      requests.push(path)
      const json = body => ({ ok: true, status: 200, headers: new Map(), json: async () => body })
      if (path === '/guilds/g1/channels') return json([{ id: 'c1', type: 0, name: 'general' }, { id: 'v1', type: 2, name: 'vc' }, { id: 'cat', type: 4 }, { id: 'staff', type: 0 }])
      if (path === '/guilds/g1/threads/active') return json({ threads: [] })
      if (path.startsWith('/channels/c1/threads/archived/public')) return json({ threads: [{ id: 't1', type: 11, thread_metadata: { archive_timestamp: '2026-02-02T00:00:00Z' } }], has_more: false })
      if (path.includes('/threads/archived/')) return json({ threads: [], has_more: false })
      if (path.startsWith('/channels/staff/')) return { ok: false, status: 403, headers: new Map() }
      const m = path.match(/^\/channels\/(\w+)\/messages\?limit=100(?:&before=(\d+))?$/)
      const all = history[m[1]]
      const start = m[2] ? all.findIndex(id => BigInt(id) < BigInt(m[2])) : 0
      return json(start === -1 ? [] : all.slice(start, start + 100).map(id => ({ id })))
    }
    let waited = 0
    const get = discordClient({ token: 't', fetchImpl, wait: async ms => { waited += ms } })
    const result = await backfill({ pool, get })

    assert.deepEqual(result, { filled: 3, remaining: 1 })
    const rows = await q('SELECT id, channel_id, guild_id FROM messages ORDER BY ts, id::numeric')
    assert.deepEqual(rows.map(r => [r.id, r.channel_id, r.guild_id]), [
      [general[3], 'c1', 'g1'], [general[140], 'c1', 'g1'], [inThread, 't1', 'g1'], [gone, null, null], [known, 'c9', 'g1']
    ])
    assert.deepEqual((await q('SELECT id FROM messages WHERE NOT embedded ORDER BY ts, id::numeric')).map(r => r.id), [general[3], general[140], inThread], 'filled ones are embedded again')
    assert.equal(requests.filter(p => p.startsWith('/channels/c1/messages')).length, 2, 'two pages of 100 cover the 150 messages')
    assert.equal(waited, 0)
    // Run again: nothing left that Discord still has.
    assert.deepEqual(await backfill({ pool, get }), { filled: 0, remaining: 1 })
  })

  test('waits out a rate limit and tries again', async () => {
    let calls = 0
    const waits = []
    const get = discordClient({
      token: 't',
      wait: async ms => waits.push(ms),
      fetchImpl: async () => ++calls === 1
        ? { ok: false, status: 429, headers: new Map(), json: async () => ({ retry_after: 1.5 }) }
        : { ok: true, status: 200, headers: new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset-after', '0.2']]), json: async () => ['ok'] }
    })
    assert.deepEqual(await get('/x'), ['ok'])
    assert.deepEqual(waits, [1500, 200])
  })
})
