const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const youtubeSync = require('../../src/bot/modules/youtubeSync')
const firstChannel = async () => (await require('../../src/db/interfaces/postgres/youtube').listChannels())[0]

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
    assert.equal(await youtubeSync.syncIfChanged(await firstChannel()), null)
    assert.deepEqual(calls, ['feed'])
    assert.deepEqual(store.writes, [])
  })

  test('syncs when the feed shows a new video', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    const calls = fakeYouTube({ feed: [id(2), id(1)], newVideos: [id(2)] })
    assert.equal(await youtubeSync.syncIfChanged(await firstChannel()), 1)
    assert.deepEqual(calls, ['feed', 'channels', 'playlistItems', 'videos'])
    assert.ok(store.knowledge[100].videos.some(v => v.video_id === id(2)))
  })

  test('syncs while a stream is live or upcoming, or older videos are left to read, without the feed', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    store.knowledge[100].videos = [video(1, { live_status: 'upcoming' })]
    let calls = fakeYouTube()
    await youtubeSync.syncIfChanged(await firstChannel())
    assert.equal(calls[0], 'channels')

    store.knowledge[100].videos = [video(1)]
    store.knowledge[100].channel.backfill_token = 'p3'
    calls = fakeYouTube()
    await youtubeSync.syncIfChanged(await firstChannel())
    assert.equal(calls[0], 'channels')
  })
})

describe('autoSyncAll', () => {
  afterEach(() => { delete global.bot })

  test('checks every channel the bot follows, once, and one failure does not stop the rest', async (t) => {
    process.env.YOUTUBE_API_KEY = 'k'
    installYouTubeStore({
      100: { channel: { channel_id: UC }, videos: [] },
      200: { channel: { channel_id: 'UC' + 'd'.repeat(22) }, videos: [] },
      300: { channel: { channel_id: UC }, videos: [] }
    })
    global.bot = { shards: new Map([[0, { id: 0 }]]), guilds: new Map() }
    const warned = t.mock.method(global.logger, 'warn', () => {})
    const feeds = []
    global.fetch = async url => {
      const channel = new URL(url).searchParams.get('channel_id')
      feeds.push(channel)
      if (channel === UC) return { ok: false, status: 500 }
      return { ok: true, text: async () => '<feed></feed>' }
    }
    await youtubeSync.autoSyncAll()
    assert.deepEqual(feeds, [UC, 'UC' + 'd'.repeat(22)], 'a channel two servers use is read once')
    assert.match(warned.mock.calls[0].arguments[0], new RegExp(`Automatic sync of ${UC} failed: .*HTTP 500`))
  })

  test('only the worker owning shard 0 syncs: the channels are the bot\'s', async () => {
    installYouTubeStore({ 100: { channel: { channel_id: UC }, videos: [] } })
    global.bot = { shards: new Map([[3, { id: 3 }]]), guilds: new Map() }
    const feeds = []
    global.fetch = async () => { feeds.push('feed'); return { ok: true, text: async () => '' } }
    await youtubeSync.autoSyncAll()
    assert.deepEqual(feeds, [])
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

describe('syncing on YouTube pushes', () => {
  afterEach(() => {
    delete global.bot
    delete process.env.YOUTUBE_WEBSUB_URL
    delete process.env.YOUTUBE_WEBSUB_SECRET
  })

  test('a push syncs that channel once, if the bot follows it', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    process.env.YOUTUBE_API_KEY = 'k'
    const store = installYouTubeStore({
      100: { channel: { channel_id: UC }, videos: [] },
      200: { channel: { channel_id: UC }, videos: [] },
      300: { channel: { channel_id: 'UC' + 'q'.repeat(22) }, videos: [] }
    })
    global.bot = { shards: new Map([[0, { id: 0 }]]), guilds: new Map() }
    fakeYouTube({ newVideos: [id(9)] })
    await youtubeSync.syncOnPush(UC)
    await youtubeSync.syncOnPush('UC' + 'z'.repeat(22))
    assert.deepEqual(store.writes.map(w => w.saveSync), [UC])
  })

  test('with pushes set up, there is no timed sync; without, there is', (t) => {
    t.mock.method(global.logger, 'startup', () => {})
    const timers = t.mock.method(global, 'setInterval', () => 'timer')
    process.env.YOUTUBE_API_KEY = 'k'
    process.env.YOUTUBE_WEBSUB_URL = 'https://robo.example'
    process.env.YOUTUBE_WEBSUB_SECRET = 's'
    assert.equal(youtubeSync.startAutoSync(), null)
    assert.equal(timers.mock.callCount(), 0)
    delete process.env.YOUTUBE_WEBSUB_URL
    assert.equal(youtubeSync.startAutoSync(), 'timer')
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

  test('with force, picks the newest videos whether or not they were summarized, and replaces the summary', async () => {
    const picked = await youtubeSync.videosToSummarize('100', 2, { force: true })
    assert.deepEqual(picked.map(v => v.video_id), [id(4), id(3)])
    const requests = installGemini([[{ text: '新しい要約' }]])
    const store = require('../../src/db/interfaces/postgres/youtube')
    await youtubeSync.summarizeLatest('100', [picked[1]], { force: true })
    assert.equal(requests.length, 1, 'the stored summary is not reused')
    assert.equal(await store.getSummary(id(3)), '新しい要約')
  })

  test('summarizes them, reporting progress and failures without stopping', async () => {
    installGemini([[{ text: '要約A' }], new Error('boom')])
    const progress = []
    const results = await youtubeSync.summarizeLatest('100', await youtubeSync.videosToSummarize('100', 2), {
      concurrency: 1,
      onProgress: ({ done, total, running }) => progress.push(`${done}/${total} ${running.map(v => v.title).join(',')}`)
    })
    assert.deepEqual(progress, ['0/2 動画4', '1/2 動画2'])
    assert.deepEqual(results.map(r => [r.video.video_id, r.error]), [[id(4), null], [id(2), 'AI の呼び出しに失敗しました（HTTP 500）']])
  })

  test('summarizes several at once, never more than the limit, and keeps the order of the results', async (t) => {
    const videoSummary = require('../../src/bot/modules/videoSummary')
    let running = 0
    let most = 0
    const finish = []
    t.mock.method(videoSummary, 'summarizeVideo', async (guildID, url) => {
      running++
      most = Math.max(most, running)
      // Later videos finish first, so the results are not in finishing order.
      await new Promise(resolve => setTimeout(resolve, 30 - Number(url.slice(-1)) * 5))
      running--
      finish.push(url.slice(-1))
      if (url.endsWith('3')) throw new Error('boom')
    })
    const videos = Array.from({ length: 5 }, (_, i) => ({ title: `v${i}`, url: `https://youtu.be/x${i}` }))
    const progress = []
    const results = await youtubeSync.summarizeLatest('100', videos, { concurrency: 3, onProgress: p => progress.push(p.running.length) })
    assert.equal(most, 3)
    assert.notDeepEqual(finish, ['0', '1', '2', '3', '4'])
    assert.deepEqual(results.map(r => [r.video.title, r.error]), [['v0', null], ['v1', null], ['v2', null], ['v3', 'boom'], ['v4', null]])
    assert.deepEqual(progress.slice(0, 3), [1, 2, 3])
  })

  test('summarizes the shortest first, those of unknown length last, the results still in the given order', async (t) => {
    const videoSummary = require('../../src/bot/modules/videoSummary')
    const started = []
    t.mock.method(videoSummary, 'summarizeVideo', async (guildID, url) => { started.push(url.slice(-1)) })
    const videos = [['0', 'PT1H2M'], ['1', null], ['2', 'PT45S'], ['3', 'PT10M'], ['4', 'P1DT1S'], ['5', 'PT10M']]
      .map(([n, duration]) => ({ title: `v${n}`, url: `https://youtu.be/x${n}`, duration }))
    const results = await youtubeSync.summarizeLatest('100', videos, { concurrency: 1 })
    assert.deepEqual(started, ['2', '3', '5', '0', '4', '1'])
    assert.deepEqual(results.map(r => r.video.title), ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  })

  test('the number at once comes from VIDEO_SUMMARY_CONCURRENCY, 1 to 10, 3 by default', () => {
    const cases = [[undefined, 3], ['5', 5], ['0', 3], ['abc', 3], ['50', 10]]
    try {
      for (const [value, expected] of cases) {
        if (value === undefined) delete process.env.VIDEO_SUMMARY_CONCURRENCY
        else process.env.VIDEO_SUMMARY_CONCURRENCY = value
        assert.equal(youtubeSync.summaryConcurrency(), expected, String(value))
      }
    } finally {
      delete process.env.VIDEO_SUMMARY_CONCURRENCY
    }
  })
})

describe('the channels the bot follows', () => {
  afterEach(() => { process.env.YOUTUBE_CHANNELS = '' })

  test('YOUTUBE_CHANNELS names them; every one is resolved before anything changes', async () => {
    process.env.YOUTUBE_API_KEY = 'k'
    const store = installYouTubeStore()
    const calls = fakeYouTube()
    process.env.YOUTUBE_CHANNELS = `${UC}, @other`
    assert.deepEqual(await youtubeSync.applyConfiguredChannels(), [{ ref: UC, id: UC }, { ref: '@other', id: UC }])
    assert.deepEqual(calls, ['channels'], 'an ID needs no lookup; a handle does')
    assert.deepEqual(store.writes, [{ setBotChannels: [{ ref: UC, id: UC }, { ref: '@other', id: UC }] }])
    process.env.YOUTUBE_CHANNELS = `${UC}, not a channel`
    store.writes.length = 0
    await assert.rejects(youtubeSync.applyConfiguredChannels(), /not a channel/)
    assert.deepEqual(store.writes, [], 'nothing changes')
  })

  test('the default is のばまんゲームス', () => {
    delete process.env.YOUTUBE_CHANNELS
    try {
      assert.deepEqual(youtubeSync.configuredChannels(), ['UCTW2tw0Mhho72MojB1L48IQ'])
    } finally {
      process.env.YOUTUBE_CHANNELS = ''
    }
  })
})
