const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { parseChannelRef, fetchChannelKnowledge } = require('../../src/bot/utils/youtube')

const UC = 'UC' + 'a'.repeat(22)

describe('parseChannelRef', () => {
  for (const [input, expected] of [
    ['https://www.youtube.com/@NobamanChannel', { handle: 'NobamanChannel' }],
    ['https://youtube.com/@nobaman/videos', { handle: 'nobaman' }],
    ['@nobaman', { handle: 'nobaman' }],
    [`https://www.youtube.com/channel/${UC}`, { id: UC }],
    [`https://www.youtube.com/channel/${UC}/live`, { id: UC }],
    [UC, { id: UC }],
    ['  @nobaman  ', { handle: 'nobaman' }],
    ['@ロボポリス', { handle: 'ロボポリス' }],
    ['https://www.youtube.com/@%E3%83%AD%E3%83%9C%E3%83%9D%E3%83%AA%E3%82%B9/videos', { handle: 'ロボポリス' }]
  ]) {
    test(`reads ${input.trim()}`, () => assert.deepEqual(parseChannelRef(input), expected))
  }

  for (const input of ['', 'nobaman', 'https://www.youtube.com/c/legacyName', 'https://www.youtube.com/watch?v=abc', 'UCshort', '@a']) {
    test(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseChannelRef(input), null))
  }
})

describe('fetchChannelKnowledge', () => {
  // A fake YouTube API that answers the three calls a sync makes, and records them.
  function fakeApi (overrides = {}) {
    const calls = []
    global.fetch = async (url, init) => {
      const u = new URL(url)
      calls.push({ path: u.pathname.split('/').pop(), params: Object.fromEntries(u.searchParams), url, headers: init.headers })
      const answers = {
        channels: { items: [{ id: UC, snippet: { title: 'のばまんチャンネル', description: 'ゲーム配信', customUrl: '@nobaman' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }] },
        playlistItems: { items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] },
        videos: {
          items: [
            { id: 'v1', snippet: { title: '雑談配信', description: 'x'.repeat(2000), publishedAt: '2026-10-20T10:00:00Z', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1H2M' } },
            { id: 'v2', snippet: { title: '11/3 記念配信', description: '告知', publishedAt: '2026-10-28T10:00:00Z', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: '2026-11-03T11:00:00Z' }, contentDetails: { duration: 'P0D' } }
          ]
        },
        ...overrides
      }
      const answer = answers[calls[calls.length - 1].path]
      if (answer instanceof Error) return { ok: false, status: 403, text: async () => answer.message }
      return { ok: true, json: async () => answer }
    }
    return calls
  }

  test('reads the channel by handle, its uploads, then the video details', async () => {
    const calls = fakeApi()
    const result = await fetchChannelKnowledge({ handle: 'nobaman' }, 'yt-key')
    assert.deepEqual(calls.map(c => c.path), ['channels', 'playlistItems', 'videos'])
    assert.equal(calls[0].params.forHandle, 'nobaman')
    assert.equal(calls[1].params.playlistId, 'UU' + 'a'.repeat(22))
    assert.equal(calls[2].params.id, 'v1,v2')
    assert.ok(calls.every(c => c.headers['x-goog-api-key'] === 'yt-key'), 'the key is sent as a header')
    assert.ok(calls.every(c => !c.url.includes('yt-key')), 'and never in the URL')
    assert.ok(calls.every(c => c.url.startsWith('https://www.googleapis.com/youtube/v3/')), 'straight to Google by default')

    assert.deepEqual(result.channel, { id: UC, title: 'のばまんチャンネル', description: 'ゲーム配信', handle: '@nobaman', url: `https://www.youtube.com/channel/${UC}` })
    assert.equal(result.videos[0].description.length, 1000)
    assert.deepEqual(result.videos[1], {
      id: 'v2', title: '11/3 記念配信', description: '告知', publishedAt: '2026-10-28T10:00:00Z', liveStatus: 'upcoming', scheduledStart: '2026-11-03T11:00:00Z', duration: 'P0D', url: 'https://www.youtube.com/watch?v=v2'
    })
  })

  test('reads the channel by ID', async () => {
    const calls = fakeApi()
    await fetchChannelKnowledge({ id: UC }, 'k')
    assert.equal(calls[0].params.id, UC)
    assert.equal(calls[0].params.forHandle, undefined)
  })

  test('says when the channel does not exist', async () => {
    fakeApi({ channels: { items: [] } })
    await assert.rejects(fetchChannelKnowledge({ handle: 'nobody' }, 'k'), { hint: 'YouTube チャンネルが見つかりませんでした' })
  })

  test('turns API errors into a hint for the requester', async () => {
    fakeApi({ channels: new Error('quotaExceeded') })
    await assert.rejects(fetchChannelKnowledge({ handle: 'x' }, 'k'), { hint: 'YouTube API の呼び出しに失敗しました（HTTP 403）', message: /quotaExceeded/ })
  })

  test('handles a channel without uploads', async () => {
    const calls = fakeApi({ playlistItems: { items: [] } })
    assert.deepEqual((await fetchChannelKnowledge({ handle: 'x' }, 'k')).videos, [])
    assert.deepEqual(calls.map(c => c.path), ['channels', 'playlistItems'])
  })
})

describe('parseVideoId', () => {
  const { parseVideoId } = require('../../src/bot/utils/youtube')
  for (const [input, id] of [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=shared', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['見て https://youtu.be/dQw4w9WgXcQ おすすめ', 'dQw4w9WgXcQ']
  ]) {
    test(`reads ${input}`, () => assert.equal(parseVideoId(input), id))
  }
  for (const input of ['https://www.youtube.com/@nobaman', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', '']) {
    test(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseVideoId(input), null))
  }
})

describe('fetchChannelKnowledge paging', () => {
  // A channel with `pages` pages of uploads, newest first: page 0 has v0..v49, page 1 v50..v99, …
  function pagedApi (pages) {
    const calls = []
    global.fetch = async url => {
      const u = new URL(url)
      const path = u.pathname.split('/').pop()
      calls.push({ path, token: u.searchParams.get('pageToken') })
      if (path === 'channels') return { ok: true, json: async () => ({ items: [{ id: UC, snippet: { title: 'ch' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }) }
      if (path === 'playlistItems') {
        const page = Number(u.searchParams.get('pageToken') || 0)
        const items = Array.from({ length: 50 }, (_, i) => ({ contentDetails: { videoId: `v${page * 50 + i}` } }))
        return { ok: true, json: async () => ({ items, ...(page + 1 < pages ? { nextPageToken: String(page + 1) } : {}) }) }
      }
      const ids = u.searchParams.get('id').split(',')
      return { ok: true, json: async () => ({ items: ids.map(id => ({ id, snippet: { title: id, publishedAt: '2026-01-01T00:00:00Z' } })) }) }
    }
    return calls
  }

  test('reads the whole channel when nothing is known yet', async () => {
    const calls = pagedApi(3)
    const { videos, backfillToken } = await fetchChannelKnowledge({ id: UC }, 'k')
    assert.equal(videos.length, 150)
    assert.equal(backfillToken, null)
    assert.deepEqual(calls.filter(c => c.path === 'playlistItems').map(c => c.token), [null, '1', '2'])
  })

  test('afterwards stops at the first page whose videos are all known', async () => {
    const calls = pagedApi(5)
    // v0..v9 are new; everything from v10 on is stored, so page 1 is all known.
    const knownIds = new Set(Array.from({ length: 240 }, (_, i) => `v${i + 10}`))
    const { videos, backfillToken } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds })
    assert.deepEqual(calls.filter(c => c.path === 'playlistItems').map(c => c.token), [null, '1'])
    assert.equal(videos.length, 100)
    assert.equal(backfillToken, null)
  })

  test('always re-reads the newest page, even when it is all known', async () => {
    const calls = pagedApi(5)
    const knownIds = new Set(Array.from({ length: 250 }, (_, i) => `v${i}`))
    const { videos } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds })
    assert.deepEqual(calls.map(c => c.path), ['channels', 'playlistItems', 'videos'])
    assert.equal(videos.length, 50, 'the newest page is refreshed (e.g. an upcoming stream that went live)')
  })

  test('stops at the page limit and returns where to continue', async () => {
    pagedApi(10)
    const { videos, backfillToken } = await fetchChannelKnowledge({ id: UC }, 'k', { maxPages: 3 })
    assert.equal(videos.length, 150)
    assert.equal(backfillToken, '3')
  })

  test('a later read takes what is new, then continues the interrupted backfill', async () => {
    const calls = pagedApi(10)
    // The first read stored v0..v149 and stopped before page 3. Nothing new since.
    const knownIds = new Set(Array.from({ length: 150 }, (_, i) => `v${i}`))
    const { videos, backfillToken } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds, backfillToken: '3', maxPages: 4 })
    assert.deepEqual(calls.filter(c => c.path === 'playlistItems').map(c => c.token), [null, '3', '4', '5'])
    assert.equal(videos.length, 200, 'the refreshed newest page plus three older pages')
    assert.equal(backfillToken, '6')
  })

  test('the backfill finishes when the oldest page is reached', async () => {
    pagedApi(5)
    const knownIds = new Set(Array.from({ length: 150 }, (_, i) => `v${i}`))
    const { backfillToken } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds, backfillToken: '3' })
    assert.equal(backfillToken, null)
  })
})

describe('routing through Cloudflare AI Gateway', () => {
  const env = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID', 'CLOUDFLARE_AI_GATEWAY_TOKEN', 'YOUTUBE_GATEWAY_PROVIDER']
  let saved
  beforeEach(() => { saved = Object.fromEntries(env.map(k => [k, process.env[k]])) })
  afterEach(() => { for (const k of env) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]) })

  function recordingApi () {
    const calls = []
    global.fetch = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return { ok: true, json: async () => ({ items: [{ id: UC, snippet: { title: 'ch' }, contentDetails: {} }] }) }
    }
    return calls
  }

  test('goes through the custom provider when YOUTUBE_GATEWAY_PROVIDER is set', async () => {
    Object.assign(process.env, { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_AI_GATEWAY_ID: 'gw', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gw-token', YOUTUBE_GATEWAY_PROVIDER: 'youtube' })
    const calls = recordingApi()
    await fetchChannelKnowledge({ handle: 'nobaman' }, 'yt-key')
    assert.equal(calls[0].url, 'https://gateway.ai.cloudflare.com/v1/acct/gw/custom-youtube/youtube/v3/channels?part=snippet%2CcontentDetails&forHandle=nobaman')
    assert.deepEqual(calls[0].headers, { 'x-goog-api-key': 'yt-key', 'cf-aig-authorization': 'Bearer gw-token' })
  })

  test('goes straight to Google when the provider is not set, or the gateway is not configured', async () => {
    Object.assign(process.env, { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_AI_GATEWAY_ID: 'gw', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gw-token' })
    delete process.env.YOUTUBE_GATEWAY_PROVIDER
    let calls = recordingApi()
    await fetchChannelKnowledge({ handle: 'x' }, 'k')
    assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?/)
    assert.deepEqual(calls[0].headers, { 'x-goog-api-key': 'k' }, 'the gateway token never goes to Google')

    process.env.YOUTUBE_GATEWAY_PROVIDER = 'youtube'
    delete process.env.CLOUDFLARE_AI_GATEWAY_ID
    calls = recordingApi()
    await fetchChannelKnowledge({ handle: 'x' }, 'k')
    assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\//)
  })
})
