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

    assert.deepEqual(result.channel, { id: UC, title: 'のばまんチャンネル', description: 'ゲーム配信', handle: '@nobaman', subscriberCount: null, viewCount: null, url: `https://www.youtube.com/channel/${UC}` })
    assert.equal(result.videos[0].description.length, 1000)
    assert.deepEqual(result.videos[1], {
      id: 'v2', channelId: null, channelTitle: null, title: '11/3 記念配信', description: '告知', publishedAt: '2026-10-28T10:00:00Z', liveStatus: 'upcoming', scheduledStart: '2026-11-03T11:00:00Z', actualStart: null, actualEnd: null, isStream: true, thumbnail: null, duration: 'P0D', viewCount: null, likeCount: null, commentCount: null, url: 'https://www.youtube.com/watch?v=v2'
    })
  })

  test('reads channel and video statistics and respects hiddenSubscriberCount', async () => {
    fakeApi({
      channels: {
        items: [{
          id: UC,
          snippet: { title: 'のばまんチャンネル', description: 'ゲーム配信', customUrl: '@nobaman' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } },
          statistics: { subscriberCount: '625000', hiddenSubscriberCount: false, viewCount: '245000000' }
        }]
      },
      videos: {
        items: [{
          id: 'v1',
          snippet: { channelId: UC, channelTitle: 'のばまんチャンネル', title: '神回', description: '', publishedAt: '2026-10-27T16:30:00Z', liveBroadcastContent: 'none' },
          contentDetails: { duration: 'PT12M34S' },
          statistics: { viewCount: '152300', likeCount: '8420', commentCount: '512' }
        }]
      }
    })
    const result = await fetchChannelKnowledge({ handle: 'nobaman' }, 'yt-key')
    assert.equal(result.channel.subscriberCount, 625000)
    assert.equal(result.channel.viewCount, 245000000)
    assert.equal(result.videos[0].channelId, UC)
    assert.equal(result.videos[0].channelTitle, 'のばまんチャンネル')
    assert.equal(result.videos[0].viewCount, 152300)
    assert.equal(result.videos[0].likeCount, 8420)
    assert.equal(result.videos[0].commentCount, 512)

    fakeApi({
      channels: {
        items: [{
          id: UC,
          snippet: { title: '非公開ch' },
          contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } },
          statistics: { subscriberCount: '625000', hiddenSubscriberCount: true, viewCount: '1000' }
        }]
      },
      playlistItems: { items: [] }
    })
    const hidden = await fetchChannelKnowledge({ id: UC }, 'yt-key')
    assert.equal(hidden.channel.subscriberCount, null)
    assert.equal(hidden.channel.viewCount, 1000)
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
  const { parseVideoId, parseVideoIds } = require('../../src/bot/utils/youtube')
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
  test('parseVideoIds collects unique video IDs in order', () => {
    assert.deepEqual(
      parseVideoIds('比較 https://youtu.be/dQw4w9WgXcQ と https://www.youtube.com/watch?v=abcdefghijk と https://youtu.be/dQw4w9WgXcQ'),
      ['dQw4w9WgXcQ', 'abcdefghijk']
    )
  })
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
    assert.equal(calls[0].url, 'https://gateway.ai.cloudflare.com/v1/acct/gw/custom-youtube/youtube/v3/channels?part=snippet%2CcontentDetails%2Cstatistics&forHandle=nobaman')
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

describe('linkTimestamps', () => {
  const { linkTimestamps } = require('../../src/bot/utils/youtube')

  test('turns the times of a summary into links that open the video there', () => {
    assert.equal(
      linkTimestamps('- [0:00] 挨拶\n- [12:34] 告知\n- [1:02:03] 質問コーナー', 'abcdefghijk'),
      '- [0:00](https://www.youtube.com/watch?v=abcdefghijk&t=0s) 挨拶\n' +
      '- [12:34](https://www.youtube.com/watch?v=abcdefghijk&t=754s) 告知\n' +
      '- [1:02:03](https://www.youtube.com/watch?v=abcdefghijk&t=3723s) 質問コーナー'
    )
  })

  test('leaves other brackets, existing links and summaries without times alone', () => {
    const text = '[告知] 11/3 [12:34](https://x) 時間なしの要約'
    assert.equal(linkTimestamps(text, 'abcdefghijk'), text)
    assert.equal(linkTimestamps(null, 'abcdefghijk'), '')
  })
})

describe('durationSeconds and deterministic formatters', () => {
  const { durationSeconds, formatDuration, formatCount, formatJstDate, formatJstIso } = require('../../src/bot/utils/youtube')
  test('reads YouTube\'s ISO 8601 durations, null when there is none', () => {
    assert.equal(durationSeconds('PT45S'), 45)
    assert.equal(durationSeconds('PT1H2M3S'), 3723)
    assert.equal(durationSeconds('PT10M'), 600)
    assert.equal(durationSeconds('P1DT1S'), 86401)
    assert.equal(durationSeconds('P0D'), 0)
    for (const none of [null, '', 'P', 'PT', 'abc']) assert.equal(durationSeconds(none), null, String(none))
  })

  test('formats durations, counts with Japanese units, and dates/timestamps in Asia/Tokyo', () => {
    assert.equal(formatDuration('PT45S'), '45秒')
    assert.equal(formatDuration('PT10M'), '10分')
    assert.equal(formatDuration('PT1H2M3S'), '1時間2分3秒')
    assert.equal(formatDuration('P0D'), null)
    assert.equal(formatDuration(null), null)

    assert.equal(formatCount(850, '回'), '850回')
    assert.equal(formatCount(10000, '回'), '10,000回（1万回）')
    assert.equal(formatCount('152300', '回'), '152,300回（15万2,300回）')
    assert.equal(formatCount(245000000, '回'), '245,000,000回（2億4,500万回）')
    assert.equal(formatCount(null, '回'), null)

    // 2026-10-27T16:30:00Z is 2026-10-28 01:30:00 in Japan (+09:00), not Oct 27.
    assert.equal(formatJstDate('2026-10-27T16:30:00Z'), '2026-10-28')
    assert.equal(formatJstIso('2026-10-27T16:30:00Z'), '2026-10-28T01:30:00+09:00')
    assert.equal(formatJstDate(null), null)
    assert.equal(formatJstIso('not-a-date'), null)
  })
})
