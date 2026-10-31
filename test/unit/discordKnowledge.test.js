// The streamer's Discord messages as knowledge: which channels, reading their history, and following new ones.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Constants } = require('eris')
const store = require('../../src/db/interfaces/postgres/discordPosts')
const knowledgeStore = require('../../src/db/interfaces/postgres/discordKnowledge')
const discord = require('../../src/bot/modules/discordKnowledge')

const P = Constants.Permissions
const OWNER = '615170683068219393'
const NOBAMAN = '615170548187791365'

const channel = (id, { type = 0, everyone = null, botCan = true, name = `ch${id}` } = {}) => ({
  id,
  type,
  name,
  permissionOverwrites: new Map(everyone ? [[OWNER, everyone]] : []),
  permissionsOf: () => ({ has: () => botCan })
})
const guild = (channels, everyoneAllow = P.viewChannel | P.readMessageHistory) => ({
  id: OWNER,
  roles: new Map([[OWNER, { permissions: { allow: everyoneAllow } }]]),
  channels: new Map(channels.map(c => [c.id, c]))
})
const message = (id, author, content, at = '2026-10-15T03:00:00Z') => ({ id, author: { id: author, username: `u${author}` }, content, timestamp: Date.parse(at) })

beforeEach(() => {
  process.env.DISCORD_KNOWLEDGE_USERS = NOBAMAN
  global.bot = { user: { id: 'BOT' }, guilds: new Map() }
})
afterEach(() => {
  delete process.env.DISCORD_KNOWLEDGE_USERS
  delete global.bot
})

describe('which channels', () => {
  test('only text and announcement channels everyone and the bot can read, with their history', () => {
    const g = guild([
      channel('1'),
      channel('2', { type: 5 }),
      channel('3', { everyone: { allow: 0n, deny: P.viewChannel } }),
      channel('4', { everyone: { allow: 0n, deny: P.readMessageHistory } }),
      channel('5', { botCan: false }),
      channel('6', { type: 2 }),
      channel('7', { type: 4 })
    ])
    assert.deepEqual(discord.publicChannels(g).map(c => c.id), ['1', '2'])
    // A server where everyone cannot see channels: only those opened to everyone.
    const closed = guild([channel('1'), channel('2', { everyone: { allow: P.viewChannel | P.readMessageHistory, deny: 0n } })], 0n)
    assert.deepEqual(discord.publicChannels(closed).map(c => c.id), ['2'])
  })
})

describe('reading a channel\'s history', () => {
  test('back to its start, keeping only the accounts\' messages, from where the last read stopped', async (t) => {
    const ch = channel('10', { name: '雑談' })
    const g = guild([ch])
    let state = { before_id: '900', done: false }
    t.mock.method(store, 'backfillState', async () => state)
    const saved = []
    t.mock.method(store, 'saveBackfill', async (guildID, channelID, before, done) => { state = { before_id: before, done }; saved.push([before, done]) })
    const stored = []
    t.mock.method(store, 'savePosts', async posts => { stored.push(...posts); return posts })
    t.mock.method(store, 'postsOfMonth', async () => stored.map(p => ({ id: p.id, channel_id: p.channelID, channel_name: p.channelName, author_name: p.authorName, content: p.content, created_at: p.createdAt })))
    const pages = []
    t.mock.method(knowledgeStore, 'savePage', async (url, title, sections) => pages.push([url, title, sections[0].text]))
    const asked = []
    const full = Array.from({ length: 100 }, (_, i) => message(String(800 - i), i === 5 ? NOBAMAN : '2', i === 5 ? '今日は配信するよ' : 'こんにちは'))
    const pagesOfHistory = [full, [message('600', NOBAMAN, ''), message('599', NOBAMAN, 'おやすみ')]]
    const getMessages = async (id, options) => { asked.push(options.before); return pagesOfHistory.shift() }
    assert.equal(await discord.readChannel(g, ch, { wait: 0, getMessages }), 2)
    assert.deepEqual(asked, ['900', '701'], 'from where it stopped, then from the oldest read')
    assert.deepEqual(saved, [['701', false], ['599', true]])
    assert.deepEqual(stored.map(p => [p.id, p.content, p.channelName]), [['795', '今日は配信するよ', '雑談'], ['599', 'おやすみ', '雑談']])
    assert.equal(pages[0][0], `https://discord.com/channels/${OWNER}#${NOBAMAN}-2026-10`)
    assert.match(pages[0][1], /の Discord の発言（2026年10月）/)
    assert.match(pages[0][2], new RegExp(`^\\[2026-10-15\\] #雑談: 今日は配信するよ https://discord\\.com/channels/${OWNER}/10/795$`, 'm'))

    // Read to its start: not read again.
    asked.length = 0
    assert.equal(await discord.readChannel(g, ch, { wait: 0, getMessages }), 0)
    assert.deepEqual(asked, [])
  })
})

describe('following messages', () => {
  test('a new message of the account in a public channel of the owner\'s server is kept; others are not', async (t) => {
    const ch = channel('10')
    const g = guild([ch, channel('11', { everyone: { allow: 0n, deny: P.viewChannel } })])
    const saved = t.mock.method(store, 'savePosts', async posts => posts)
    t.mock.method(store, 'postsOfMonth', async () => [{ id: '1', channel_id: '10', channel_name: 'ch10', author_name: 'のばまん', content: '告知', created_at: new Date('2026-10-15T03:00:00Z') }])
    const pages = t.mock.method(knowledgeStore, 'savePage', async () => {})
    const inChannel = (c, m, gg = g) => ({ ...m, channel: { ...c, guild: gg } })
    await discord.onMessage(inChannel(ch, message('1', NOBAMAN, '告知')))
    await discord.onMessage(inChannel(ch, message('2', '2', 'ほかの人')))
    await discord.onMessage(inChannel(g.channels.get('11'), message('3', NOBAMAN, '非公開チャンネル')))
    await discord.onMessage(inChannel(ch, message('4', NOBAMAN, '別サーバー'), { ...g, id: '999' }))
    assert.deepEqual(saved.mock.calls.map(c => c.arguments[0][0].id), ['1'])
    assert.equal(pages.mock.callCount(), 1)
  })

  test('a deleted message leaves the knowledge; a month with none left loses its page', async (t) => {
    t.mock.method(store, 'deletePost', async id => id === '1' ? { guild_id: OWNER, author_id: NOBAMAN, created_at: new Date('2026-10-15T03:00:00Z') } : null)
    t.mock.method(store, 'postsOfMonth', async () => [])
    const removed = t.mock.method(knowledgeStore, 'deletePagesExcept', async () => 1)
    await discord.onDelete('1')
    await discord.onDelete('2')
    assert.deepEqual(removed.mock.calls.map(c => c.arguments), [[`https://discord.com/channels/${OWNER}#${NOBAMAN}-2026-10`, []]])
  })

  test('nothing without DISCORD_KNOWLEDGE_USERS', async (t) => {
    delete process.env.DISCORD_KNOWLEDGE_USERS
    const saved = t.mock.method(store, 'savePosts', async posts => posts)
    await discord.onMessage({ ...message('1', NOBAMAN, 'x'), channel: { ...channel('10'), guild: guild([channel('10')]) } })
    assert.equal(saved.mock.callCount(), 0)
    assert.equal(discord.enabled(), false)
  })
})
