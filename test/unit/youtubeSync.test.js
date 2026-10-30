const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const youtubeSync = require('../../src/bot/modules/youtubeSync')

const UC = 'UC' + 'c'.repeat(22)
const id = n => `vid${String(n).padStart(8, '0')}`

function video (n, extra = {}) {
  return { video_id: id(n), title: `動画${n}`, url: `https://www.youtube.com/watch?v=${id(n)}`, published_at: new Date(Date.UTC(2026, 0, n)), live_status: 'none', ...extra }
}

// The public feed and the Data API, recording which were called.
function fakeYouTube ({ feed = [], newVideos = [] } = {}) {
  const calls = []
  global.fetch = async url => {
    const u = new URL(url)
    if (u.pathname === '/feeds/videos.xml') {
      calls.push('feed')
      return { ok: true, text: async () => `<feed>${feed.map(v => `<entry><yt:videoId>${v}</yt:videoId></entry>`).join('')}</feed>` }
    }
    const path = u.pathname.split('/').pop()
    calls.push(path)
    const answers = {
      channels: { items: [{ id: UC, snippet: { title: 'ch' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] },
      playlistItems: { items: newVideos.map(v => ({ contentDetails: { videoId: v } })) },
      videos: { items: newVideos.map(v => ({ id: v, snippet: { title: v, publishedAt: '2026-10-30T00:00:00Z', liveBroadcastContent: 'none' } })) }
    }
    return { ok: true, json: async () => answers[path] }
  }
  return calls
}

describe('feedVideoIds', () => {
  test('reads the video IDs from the channel feed, without the API', async () => {
    const calls = fakeYouTube({ feed: [id(1), id(2)] })
    assert.deepEqual(await youtubeSync.feedVideoIds(UC), [id(1), id(2)])
    assert.deepEqual(calls, ['feed'])
  })
})

describe('syncIfChanged', () => {
  let store
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = 'k'
    store = installYouTubeStore({ 100: { channel: { channel_ref: '@x', channel_id: UC }, videos: [video(1)] } })
  })

  test('does nothing, and spends no API quota, when the feed has nothing new', async () => {
    const calls = fakeYouTube({ feed: [id(1)] })
    assert.equal(await youtubeSync.syncIfChanged('100'), null)
    assert.deepEqual(calls, ['feed'])
    assert.deepEqual(store.writes, [])
  })

  test('syncs when the feed shows a new video', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    const calls = fakeYouTube({ feed: [id(2), id(1)], newVideos: [id(2)] })
    assert.equal(await youtubeSync.syncIfChanged('100'), 1)
    assert.deepEqual(calls, ['feed', 'channels', 'playlistItems', 'videos'])
    assert.ok(store.knowledge[100].videos.some(v => v.video_id === id(2)))
  })

  test('syncs while a stream is live or upcoming, or older videos are left to read, without the feed', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    store.knowledge[100].videos = [video(1, { live_status: 'upcoming' })]
    let calls = fakeYouTube()
    await youtubeSync.syncIfChanged('100')
    assert.equal(calls[0], 'channels')

    store.knowledge[100].videos = [video(1)]
    store.knowledge[100].channel.backfill_token = 'p3'
    calls = fakeYouTube()
    await youtubeSync.syncIfChanged('100')
    assert.equal(calls[0], 'channels')
  })
})

describe('autoSyncAll', () => {
  afterEach(() => { delete global.bot })

  test('checks only the servers this worker hosts, and one failure does not stop the rest', async (t) => {
    process.env.YOUTUBE_API_KEY = 'k'
    installYouTubeStore({
      100: { channel: { channel_id: UC }, videos: [] },
      200: { channel: { channel_id: 'UC' + 'd'.repeat(22) }, videos: [] },
      300: { channel: { channel_id: 'UC' + 'e'.repeat(22) }, videos: [] }
    })
    global.bot = { guilds: new Map([['100', {}], ['200', {}]]) }
    const warned = t.mock.method(global.logger, 'warn', () => {})
    const feeds = []
    global.fetch = async url => {
      const channel = new URL(url).searchParams.get('channel_id')
      feeds.push(channel)
      if (channel === UC) return { ok: false, status: 500 }
      return { ok: true, text: async () => '<feed></feed>' }
    }
    await youtubeSync.autoSyncAll()
    assert.deepEqual(feeds, [UC, 'UC' + 'd'.repeat(22)])
    assert.match(warned.mock.calls[0].arguments[0], /Automatic sync of 100 failed: .*HTTP 500/)
  })
})

describe('startAutoSync', () => {
  afterEach(() => {
    delete process.env.YOUTUBE_AUTO_SYNC_MINUTES
  })

  test('runs every 15 minutes by default, and not at all without an API key or with 0', (t) => {
    t.mock.method(global.logger, 'startup', () => {})
    const timers = t.mock.method(global, 'setInterval', () => 'timer')
    process.env.YOUTUBE_API_KEY = 'k'
    assert.equal(youtubeSync.startAutoSync(), 'timer')
    assert.equal(timers.mock.calls[0].arguments[1], 15 * 60 * 1000)
    process.env.YOUTUBE_AUTO_SYNC_MINUTES = '0'
    assert.equal(youtubeSync.startAutoSync(), null)
    delete process.env.YOUTUBE_API_KEY
    delete process.env.YOUTUBE_AUTO_SYNC_MINUTES
    assert.equal(youtubeSync.startAutoSync(), null)
  })
})

describe('summarizing the newest videos', () => {
  beforeEach(() => {
    configureGateway()
    installYouTubeStore({
      100: {
        channel: { channel_id: UC },
        videos: [video(5, { live_status: 'upcoming' }), video(4), video(3), video(2), video(1)]
      }
    }, { 100: { [id(3)]: '要約済み' } })
  })

  test('picks the newest videos without a summary, skipping streams that are not over', async () => {
    const picked = await youtubeSync.videosToSummarize('100', 2)
    assert.deepEqual(picked.map(v => v.video_id), [id(4), id(2)])
    assert.equal((await youtubeSync.videosToSummarize('100', 50)).length, 3, 'at most what there is (and never more than 10)')
  })

  test('summarizes them one by one, reporting progress and failures without stopping', async () => {
    installGemini([[{ text: '要約A' }], new Error('boom')])
    const progress = []
    const results = await youtubeSync.summarizeLatest('100', await youtubeSync.videosToSummarize('100', 2), {
      onProgress: (done, total, v) => progress.push(`${done + 1}/${total} ${v.title}`)
    })
    assert.deepEqual(progress, ['1/2 動画4', '2/2 動画2'])
    assert.deepEqual(results.map(r => [r.video.video_id, r.error]), [[id(4), null], [id(2), 'AI の呼び出しに失敗しました（HTTP 500）']])
  })
})
