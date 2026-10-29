const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { installYouTubeStore } = require('../helpers/fakes')
const command = require('../../src/bot/slashcommands/youtube')

const UC = 'UC' + 'b'.repeat(22)

// A slash command interaction as Eris hands it over, recording what the command answers.
function interaction (sub, options = []) {
  const it = { guildID: '100', data: { options: [{ name: sub, options }] }, deferred: false, replies: [] }
  it.defer = async () => { it.deferred = true }
  it.editOriginalMessage = async m => { it.replies.push(m) }
  return it
}

function fakeYouTubeApi () {
  const calls = []
  global.fetch = async url => {
    const path = new URL(url).pathname.split('/').pop()
    calls.push(path)
    const answers = {
      channels: { items: [{ id: UC, snippet: { title: 'のばまんch', description: '配信' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] },
      playlistItems: { items: [{ contentDetails: { videoId: 'v1' } }] },
      videos: { items: [{ id: 'v1', snippet: { title: '記念配信', publishedAt: '2026-10-28T00:00:00Z', liveBroadcastContent: 'upcoming' } }] }
    }
    return { ok: true, json: async () => answers[path] }
  }
  return calls
}

describe('/youtube', () => {
  let store
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = 'yt-key'
    store = installYouTubeStore()
  })

  test('is limited to members who can manage the server', () => {
    assert.deepEqual(command.userPerms, ['manageGuild'])
  })

  test('set: stores the channel, reads it at once, and shows what was stored', async () => {
    const calls = fakeYouTubeApi()
    const it = interaction('set', [{ name: 'channel', value: ' https://www.youtube.com/@nobaman ' }])
    await command.func(it)
    assert.equal(it.deferred, true, 'deferred before calling YouTube')
    assert.deepEqual(store.writes, [{ setChannelRef: ['100', 'https://www.youtube.com/@nobaman'] }, { saveSync: '100', videos: ['v1'] }])
    assert.deepEqual(calls, ['channels', 'playlistItems', 'videos'])
    const [reply] = it.replies
    assert.match(reply.content, /設定し、情報を取得しました/)
    const fields = Object.fromEntries(reply.embeds[0].fields.map(f => [f.name, f.value]))
    assert.equal(reply.embeds[0].title, 'のばまんch')
    assert.equal(fields['保存している動画'], '1 件（内容の要約あり 0 件）')
    assert.equal(fields['配信'], '配信予定: [記念配信](https://www.youtube.com/watch?v=v1)')
  })

  test('set: rejects something that is not a channel', async () => {
    const it = interaction('set', [{ name: 'channel', value: 'https://www.youtube.com/watch?v=abc' }])
    await command.func(it)
    assert.match(it.replies[0].content, /YouTube チャンネルの URL/)
    assert.deepEqual(store.writes, [])
  })

  test('sync: needs a channel to be set first, then re-reads it', async () => {
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /`\/youtube set` で設定してください/)

    store.knowledge[100] = { channel: { channel_ref: `https://www.youtube.com/channel/${UC}`, synced_at: null }, videos: [] }
    fakeYouTubeApi()
    const again = interaction('sync')
    await command.func(again)
    assert.match(again.replies[0].content, /最新の情報を取得しました。新しい動画 1 件を追加しました。/)
    assert.deepEqual(store.writes, [{ saveSync: '100', videos: ['v1'] }])
  })

  test('sync: keeps what is stored and only adds what is new', async () => {
    store.knowledge[100] = {
      channel: { channel_ref: '@nobaman', synced_at: new Date('2026-10-01T00:00:00Z') },
      videos: [{ video_id: 'old1', title: '昔の動画', published_at: new Date('2025-01-01T00:00:00Z') }]
    }
    fakeYouTubeApi()
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /新しい動画 1 件を追加しました。/)
    assert.deepEqual(store.knowledge[100].videos.map(v => v.video_id), ['v1', 'old1'])
  })

  test('set: setting the same channel again keeps what was accumulated', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@nobaman', synced_at: new Date() }, videos: [{ video_id: 'old1', title: 'x', published_at: new Date('2025-01-01T00:00:00Z') }] }
    fakeYouTubeApi()
    await command.func(interaction('set', [{ name: 'channel', value: '@nobaman' }]))
    assert.deepEqual(store.knowledge[100].videos.map(v => v.video_id), ['v1', 'old1'])
  })

  test('show: displays what is stored without calling YouTube', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: null }, videos: [] }
    global.fetch = async () => { throw new Error('must not call YouTube') }
    const it = interaction('show')
    await command.func(it)
    assert.equal(it.replies[0].embeds[0].fields.find(f => f.name === '最終取得').value, '未取得')
  })

  test('says so when the API key is not set', async () => {
    delete process.env.YOUTUBE_API_KEY
    const it = interaction('show')
    await command.func(it)
    assert.equal(it.replies[0].content, 'YOUTUBE_API_KEY が設定されていないため使えません。')
  })

  test('reports a YouTube failure with its hint, without leaking the key', async (t) => {
    t.mock.method(global.logger, 'error', () => {})
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'key=AIzaSyA1234567890abcdefghijklmnopqrstuv invalid' })
    const it = interaction('set', [{ name: 'channel', value: '@nobaman' }])
    await command.func(it)
    assert.equal(it.replies[0].content, 'YouTube の情報を取得できませんでした: YouTube API の呼び出しに失敗しました（HTTP 403）')
  })
})
