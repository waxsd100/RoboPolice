const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installTwitchStore } = require('../helpers/fakes')
const twitch = require('../../src/bot/utils/twitch')
const twitchSync = require('../../src/bot/modules/twitchSync')
const { searchTwitch } = require('../../src/bot/modules/eventTools')

const json = body => ({ ok: true, status: 200, json: async () => body })

// Twitch's API, as far as the sync reads it: a token, users and pages of archives.
function installTwitchAPI ({ users, pages }) {
  const requests = []
  let tokens = 0
  global.fetch = async (url, init = {}) => {
    url = String(url)
    requests.push({ url, init })
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) return json({ access_token: `token${++tokens}`, expires_in: 3600 })
    if (url.startsWith('https://api.twitch.tv/helix/users')) {
      const logins = new URL(url).searchParams.getAll('login')
      return json({ data: users.filter(u => logins.includes(u.login)) })
    }
    if (url.startsWith('https://api.twitch.tv/helix/videos')) {
      const params = new URL(url).searchParams
      const list = pages[params.get('user_id')] || [[]]
      const page = Number(params.get('after') || 0)
      return json({ data: list[page], pagination: page + 1 < list.length ? { cursor: String(page + 1) } : {} })
    }
    throw new Error(`unexpected ${url}`)
  }
  return requests
}

const vod = (id, title, day) => ({ id, title, description: '', url: `https://www.twitch.tv/videos/${id}`, published_at: `2026-11-0${day}T12:00:00Z`, duration: '3h2m1s', view_count: 10, type: 'archive' })

beforeEach(() => {
  process.env.TWITCH_CLIENT_ID = 'id'
  process.env.TWITCH_CLIENT_SECRET = 'secret'
  process.env.TWITCH_CHANNELS = 'Nobaman, @other_ch'
  twitch.reset()
})
afterEach(() => {
  for (const name of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']) delete process.env[name]
  process.env.TWITCH_CHANNELS = ''
})

test('off without the app\'s credentials or channels', () => {
  assert.deepEqual(twitchSync.logins(), ['nobaman', 'other_ch'])
  assert.equal(twitchSync.enabled(), true)
  delete process.env.TWITCH_CLIENT_SECRET
  assert.equal(twitchSync.enabled(), false)
  process.env.TWITCH_CLIENT_SECRET = 'secret'
  process.env.TWITCH_CHANNELS = ''
  assert.equal(twitchSync.enabled(), false)
})

test('the channels of TWITCH_CHANNELS are followed and their archives read, page by page; ones Twitch dropped go', async () => {
  const stored = installTwitchStore()
  const requests = installTwitchAPI({
    users: [{ id: '1', login: 'nobaman', display_name: 'のばまん', description: '配信' }, { id: '2', login: 'other_ch', display_name: 'other' }],
    pages: { 1: [[vod('a', 'マイクラ', 3), vod('b', 'ホラー', 2)], [vod('c', '雑談', 1)]], 2: [[]] }
  })
  await twitchSync.applyChannels()
  assert.deepEqual(stored.channels.map(c => c.login), ['nobaman', 'other_ch'])
  assert.equal(await twitchSync.syncAll(), 3)
  assert.deepEqual(stored.archives[1].map(v => v.video_id), ['a', 'b', 'c'])
  const helix = requests.filter(r => r.url.includes('/helix/'))
  assert.equal(helix[0].init.headers['Client-Id'], 'id')
  assert.equal(helix[0].init.headers.Authorization, 'Bearer token1')
  assert.equal(requests.filter(r => r.url.includes('oauth2')).length, 1, 'the token is kept')
  assert.match(requests.find(r => r.url.includes('/videos')).url, /type=archive/)

  // Twitch deleted "c".
  installTwitchAPI({ users: [], pages: { 1: [[vod('d', '新作', 4), vod('a', 'マイクラ', 3), vod('b', 'ホラー', 2)]], 2: [[]] } })
  assert.equal(await twitchSync.syncAll(), 1)
  assert.deepEqual(stored.archives[1].map(v => v.video_id), ['d', 'a', 'b'])
})

test('a channel that cannot be found changes nothing', async () => {
  const stored = installTwitchStore({ channels: [{ user_id: '1', login: 'nobaman' }] })
  installTwitchAPI({ users: [{ id: '1', login: 'nobaman' }], pages: {} })
  await assert.rejects(twitchSync.applyChannels(), /no Twitch channel other_ch/)
  assert.deepEqual(stored.channels.map(c => c.login), ['nobaman'])
})

test('a token Twitch no longer takes is replaced once', async () => {
  let videoCalls = 0
  installTwitchAPI({ users: [], pages: {} })
  const base = global.fetch
  global.fetch = async (url, init) => {
    if (String(url).includes('/helix/videos') && ++videoCalls === 1) return { ok: false, status: 401 }
    return base(url, init)
  }
  const { videos, complete } = await twitch.getArchives('9')
  assert.deepEqual(videos, [])
  assert.equal(complete, true)
  assert.equal(videoCalls, 2)
})

test('search_twitch finds archives by their title, newest first', async () => {
  installTwitchStore({
    channels: [{ user_id: '1', login: 'nobaman', display_name: 'のばまん', synced_at: new Date('2026-11-05T00:00:00Z') }],
    archives: { 1: [vod('a', 'マイクラ 建築', 3), vod('b', 'ホラーゲーム', 2), vod('c', 'マイクラ 探検', 1)].map(v => ({ video_id: v.id, title: v.title, url: v.url, published_at: v.published_at, duration: v.duration })) }
  })
  const all = await searchTwitch('')
  assert.match(all, /チャンネル: のばまん（https:\/\/www\.twitch\.tv\/nobaman、アーカイブ 3 件/)
  assert.match(all, /新しい順のアーカイブ:\n- マイクラ 建築（配信 2026-11-03、長さ 3h2m1s）https:\/\/www\.twitch\.tv\/videos\/a/)
  const found = await searchTwitch('マイクラ')
  assert.match(found, /「マイクラ」に一致したアーカイブ: 2 件/)
  assert.doesNotMatch(found, /ホラー/)
  installTwitchStore()
  assert.equal(await searchTwitch(''), 'BOT が見ている Twitch チャンネルはありません')
})
