// The log events that name who did something from the audit log: the entry must be the one of this
// change, not another role's or an older change's.
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const SENDER = path.resolve(__dirname, '../../src/bot/modules/webhooksender.js')
const EVENTS = ['channelUpdate', 'guildRoleUpdate', 'guildRoleCreate'].map(n => path.resolve(__dirname, `../../src/bot/events/${n}.js`))

const snowflakeAt = ms => String(BigInt(ms - 1420070400000) * 4194304n)
const user = (id, name) => ({ id, username: name, discriminator: '0', avatarURL: 'https://cdn.example/a.png' })

function guildWith (entries) {
  return {
    id: 'g1',
    members: new Map(),
    roles: new Map(),
    getAuditLog: async () => ({ entries, users: [] })
  }
}

describe('audit log attribution', () => {
  let saved
  let sent
  let events
  beforeEach(() => {
    saved = { bot: global.bot, logger: global.logger }
    sent = []
    for (const file of [SENDER, ...EVENTS]) delete require.cache[file]
    require.cache[SENDER] = { id: SENDER, filename: SENDER, loaded: true, exports: async pkg => { sent.push(pkg) } }
    global.bot = { user: { id: 'bot' }, guildSettingsCache: {}, getChannel: () => null }
    global.logger = { warn () {}, info () {}, error () {} }
    events = Object.fromEntries(EVENTS.map(file => [path.basename(file, '.js'), require(file)]))
  })
  afterEach(() => {
    Object.assign(global, saved)
    for (const file of [SENDER, ...EVENTS]) delete require.cache[file]
  })

  const idsOf = pkg => pkg.embeds[0].fields.find(f => f.name === 'ID').value

  it('channelUpdate does not pin a change on an old audit log entry of the same channel', async () => {
    const old = { id: snowflakeAt(Date.now() - 24 * 60 * 60 * 1000), targetID: 'c1', user: user('alice', 'alice'), before: { name: 'older' }, after: { name: 'old' } }
    const guild = guildWith([old])
    const channel = { id: 'c1', type: 0, guild, name: 'new', position: 1, topic: '', permissionOverwrites: [] }
    await events.channelUpdate.handle(channel, { ...channel, name: 'old' })
    assert.strictEqual(sent.length, 1)
    assert.match(idsOf(sent[0]), /不明/)
    assert.doesNotMatch(idsOf(sent[0]), /alice/)
    // The change shown is the one that just happened, not the old entry's.
    assert.match(JSON.stringify(sent[0].embeds[0].fields), /変更後: new/)
  })

  it('channelUpdate names the user of a fresh entry', async () => {
    const fresh = { id: snowflakeAt(Date.now() - 500), targetID: 'c1', user: user('bob', 'bob'), before: { name: 'old' }, after: { name: 'new' } }
    const guild = guildWith([fresh])
    const channel = { id: 'c1', type: 0, guild, name: 'new', position: 1, topic: '', permissionOverwrites: [] }
    await events.channelUpdate.handle(channel, { ...channel, name: 'old' })
    assert.match(idsOf(sent[0]), /ユーザー = bob/)
  })

  it('guildRoleUpdate ignores a fresh entry about another role', async () => {
    const other = { id: snowflakeAt(Date.now()), targetID: 'r2', user: user('mallory', 'mallory') }
    const role = { id: 'r1', name: 'new', color: 0 }
    await events.guildRoleUpdate.handle(guildWith([other]), role, { id: 'r1', name: 'old', color: 0 })
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent.length, 1)
    assert.match(idsOf(sent[0]), /実行者 = 不明/)
    assert.deepStrictEqual(sent[0].embeds[0].fields[0], { name: '名前', value: '変更後: new\n変更前: old' })
  })

  it('guildRoleCreate keeps the kind of role and shows the reason in its own field', async () => {
    const entry = { id: snowflakeAt(Date.now()), targetID: 'r1', user: user('carol', 'carol'), reason: 'イベント用' }
    await events.guildRoleCreate.handle(guildWith([entry]), { id: 'r1', name: 'event' })
    const fields = sent[0].embeds[0].fields
    assert.deepStrictEqual(fields.map(f => f.name), ['名前', '種類', '理由', 'ID'])
    assert.strictEqual(fields[1].value, 'ユーザー')
    assert.strictEqual(fields[2].value, 'イベント用')
    assert.match(fields[3].value, /実行者 = carol/)
  })
})
