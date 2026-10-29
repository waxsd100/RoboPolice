const { test, describe } = require('node:test')
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
    ['  @nobaman  ', { handle: 'nobaman' }]
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
    global.fetch = async url => {
      const u = new URL(url)
      calls.push({ path: u.pathname.split('/').pop(), params: Object.fromEntries(u.searchParams) })
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
    assert.ok(calls.every(c => c.params.key === 'yt-key'))

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
    const { videos, complete } = await fetchChannelKnowledge({ id: UC }, 'k')
    assert.equal(videos.length, 150)
    assert.equal(complete, true)
    assert.deepEqual(calls.filter(c => c.path === 'playlistItems').map(c => c.token), [null, '1', '2'])
  })

  test('afterwards stops at the first page whose videos are all known', async () => {
    const calls = pagedApi(5)
    // v0..v9 are new; everything from v10 on is stored, so page 1 is all known.
    const knownIds = new Set(Array.from({ length: 240 }, (_, i) => `v${i + 10}`))
    const { videos, complete } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds })
    assert.deepEqual(calls.filter(c => c.path === 'playlistItems').map(c => c.token), [null, '1'])
    assert.equal(videos.length, 100)
    assert.equal(complete, true)
  })

  test('always re-reads the newest page, even when it is all known', async () => {
    const calls = pagedApi(5)
    const knownIds = new Set(Array.from({ length: 250 }, (_, i) => `v${i}`))
    const { videos } = await fetchChannelKnowledge({ id: UC }, 'k', { knownIds })
    assert.deepEqual(calls.map(c => c.path), ['channels', 'playlistItems', 'videos'])
    assert.equal(videos.length, 50, 'the newest page is refreshed (e.g. an upcoming stream that went live)')
  })

  test('stops at the page limit and says the read is incomplete', async () => {
    pagedApi(10)
    const { videos, complete } = await fetchChannelKnowledge({ id: UC }, 'k', { maxPages: 3 })
    assert.equal(videos.length, 150)
    assert.equal(complete, false)
  })
})
