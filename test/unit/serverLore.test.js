// What each server is like: chunks of its stored public messages, taken out again only when they
// change, the style, and what goes into the server profile.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Constants } = require('eris')
const { configureGateway, installGemini, installLoreStore } = require('../helpers/fakes')
const lore = require('../../src/bot/modules/serverLore')

const P = Constants.Permissions
const GUILD = '500'
const NOW = new Date('2026-11-05T12:00:00+09:00') // a Thursday

const channel = (id, { open = true, name = `ch${id}` } = {}) => ({
  id,
  type: 0,
  name,
  permissionOverwrites: new Map(open ? [] : [[GUILD, { allow: 0n, deny: P.viewChannel }]]),
  permissionsOf: () => ({ has: () => true })
})
function guild () {
  const members = new Map([
    ['u1', { id: 'u1', nick: 'たろう', user: { id: 'u1' } }],
    ['u2', { id: 'u2', user: { id: 'u2', username: 'hanako' } }],
    ['b1', { id: 'b1', bot: true, user: { id: 'b1', bot: true } }]
  ])
  return {
    id: GUILD,
    roles: new Map([[GUILD, { permissions: { allow: P.viewChannel | P.readMessageHistory } }]]),
    members,
    channels: new Map([['c1', channel('c1', { name: '雑談' })], ['c2', channel('c2', { open: false })]])
  }
}
// n messages in the channel, a minute apart, from `start`.
const many = (channelID, n, start, text = i => `発言${i}`, author = i => (i % 2 ? 'u1' : 'u2')) =>
  Array.from({ length: n }, (_, i) => ({ guild_id: GUILD, channel_id: channelID, author_id: author(i), ts: new Date(Date.parse(start) + i * 60000).toISOString(), content: text(i) }))

beforeEach(() => {
  configureGateway()
  process.env.SERVER_LORE = 'true'
  global.bot = { user: { id: 'BOT' }, users: new Map(), guilds: new Map() }
})
afterEach(() => {
  delete process.env.SERVER_LORE
  delete process.env.SERVER_LORE_WEEKS
  installLoreStore()
})

describe('weeks', () => {
  test('a week starts on Monday, Asia/Tokyo', () => {
    assert.equal(lore.weekOf(new Date('2026-11-05T12:00:00+09:00')), '2026-11-02')
    assert.equal(lore.weekOf(new Date('2026-11-01T23:30:00+09:00')), '2026-10-26', 'Sunday belongs to the week before')
    assert.equal(lore.weekOf(new Date('2026-11-01T15:30:00Z')), '2026-11-02', 'already Monday in Tokyo')
  })

  test('a long chunk keeps lines spread over all of it', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(2, '0')}`)
    const kept = lore.fit(lines, 200)
    assert.ok(kept.join('\n').length <= 220)
    assert.equal(kept[0], 'line 00')
    assert.ok(kept.at(-1) >= 'line 80')
  })
})

describe('refreshGuild', () => {
  const facts = [{ kind: 'joke', name: '寝坊ネタ', content: '集合時間に誰かが必ず寝坊する' }]

  test('reads each busy public week once, with names and without bots; the style too', async () => {
    const messages = [
      ...many('c1', 20, '2026-11-03T10:00:00+09:00'),
      { guild_id: GUILD, channel_id: 'c1', author_id: 'b1', ts: '2026-11-03T11:00:00+09:00', content: 'BOT の発言' },
      ...many('c1', 5, '2026-10-27T10:00:00+09:00'), // too quiet a week
      ...many('c2', 30, '2026-11-03T10:00:00+09:00') // not everyone can read it
    ]
    const saved = installLoreStore({ messages })
    const requests = installGemini([[{ text: JSON.stringify(facts) }], [{ text: 'ゆるくて、語尾に「w」が多い' }]])
    const result = await lore.refreshGuild(guild(), { now: NOW, log: () => {} })
    assert.deepEqual(result, { extracted: 1, removed: 0 })
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /チャンネル: #雑談/)
    assert.match(prompt, /たろう: 発言1/)
    assert.match(prompt, /hanako: 発言0/)
    assert.doesNotMatch(prompt, /BOT の発言/)
    assert.deepEqual(saved.chunks[GUILD]['c1|2026-11-02'].facts, facts)
    assert.equal(saved.styles[GUILD], 'ゆるくて、語尾に「w」が多い')

    // Nothing changed: no Gemini call.
    installGemini([])
    assert.deepEqual(await lore.refreshGuild(guild(), { now: NOW, log: () => {} }), { extracted: 0, removed: 0 })
  })

  test('a chunk whose messages changed is read again; one out of the window goes', async () => {
    const messages = many('c1', 20, '2026-11-03T10:00:00+09:00')
    const saved = installLoreStore({ messages, styles: { [GUILD]: '前のノリ' } })
    installGemini([[{ text: '[]' }]])
    await lore.refreshGuild(guild(), { now: NOW, log: () => {} })
    messages.pop() // a message deleted (or removed with /clearmydata)
    installGemini([[{ text: JSON.stringify(facts) }]])
    assert.equal((await lore.refreshGuild(guild(), { now: NOW, log: () => {} })).extracted, 1)
    // Weeks later the chunk is out of the window.
    process.env.SERVER_LORE_WEEKS = '2'
    installGemini([])
    const later = await lore.refreshGuild(guild(), { now: new Date('2026-12-01T12:00:00+09:00'), log: () => {} })
    assert.deepEqual(later, { extracted: 0, removed: 1 })
    assert.equal(saved.styles[GUILD], undefined, 'no style without recent messages')
  })

  test('text Gemini refuses is kept with no knowledge, not sent again', async () => {
    const saved = installLoreStore({ messages: many('c1', 20, '2026-11-03T10:00:00+09:00') })
    global.fetch = async () => ({ ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) })
    await lore.refreshGuild(guild(), { now: NOW, log: () => {} })
    assert.deepEqual(saved.chunks[GUILD]['c1|2026-11-02'].facts, [])
  })
})

describe('relatedLore', () => {
  const axis = i => { const v = new Int8Array(512); v[i] = 127; return Buffer.from(v.buffer).toString('base64') }
  const { fromBase64 } = require('../../src/bot/utils/embeddings')

  test('close knowledge and the style, embedding the request only when there is knowledge', async () => {
    installLoreStore({
      facts: { [GUILD]: [{ kind: 'joke', name: '寝坊ネタ', content: '誰かが寝坊する', week: '2026-11-02', embedding: axis(0) }, { kind: 'term', name: '遠い', content: 'x', week: '2026-11-02', embedding: axis(1) }] },
      styles: { [GUILD]: 'ゆるい' }
    })
    let asked = 0
    const vectorOf = async () => { asked++; return fromBase64(axis(0)) }
    assert.deepEqual(await lore.relatedLore(GUILD, vectorOf), { facts: ['- [身内ネタ] 寝坊ネタ: 誰かが寝坊する（2026-11-02 の週）'], style: 'ゆるい' })
    assert.equal(asked, 1)
    assert.deepEqual(await lore.relatedLore('other', vectorOf), { facts: [], style: null })
    assert.equal(asked, 1, 'a server with no knowledge needs no embedding')
    delete process.env.SERVER_LORE
    assert.deepEqual(await lore.relatedLore(GUILD, vectorOf), { facts: [], style: null }, 'off unless turned on')
  })
})
