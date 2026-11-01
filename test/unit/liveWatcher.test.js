const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { installYouTubeStore } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const liveWatcher = require('../../src/bot/modules/liveWatcher')

const UC = 'UC' + 'f'.repeat(22)
const NOW = new Date('2026-11-01T10:00:00Z')

// The bot as far as events go: records every REST call and answers like Discord.
function installBot ({ canManageEvents = true, gone = [] } = {}) {
  const calls = []
  const guild = { id: '100', members: new Map([['BOT', { permissions: { has: p => p === 'manageEvents' && canManageEvents } }]]) }
  global.bot = {
    user: { id: 'BOT' },
    guilds: new Map([['100', guild]]),
    requestHandler: {
      async request (method, url, auth, body) {
        calls.push({ method, url, body })
        if (gone.some(id => url.endsWith(`/${id}`))) throw new Error('DiscordRESTError [10070]: Unknown Guild Scheduled Event')
        return method === 'POST' ? { id: `EV${calls.length}` } : {}
      }
    }
  }
  return { calls, guild }
}

const stream = (extra = {}) => ({
  id: 'live0000001',
  title: '記念配信',
  description: '周年',
  url: 'https://www.youtube.com/watch?v=live0000001',
  liveStatus: 'upcoming',
  scheduledStart: '2026-11-03T11:00:00Z',
  isStream: true,
  thumbnail: null,
  ...extra
})

describe('follow: a stream\'s event follows the stream', () => {
  let bot
  beforeEach(() => { bot = installBot() })

  test('a scheduled stream becomes an external event at its start, linking the stream', async () => {
    const next = await liveWatcher.follow(bot.guild, stream(), undefined, NOW)
    assert.equal(next.status, 'scheduled')
    assert.equal(next.eventID, 'EV1')
    const [{ method, url, body }] = bot.calls
    assert.equal(`${method} ${url}`, 'POST /guilds/100/scheduled-events')
    assert.deepEqual(body, {
      name: '記念配信',
      description: '周年\n\nhttps://www.youtube.com/watch?v=live0000001',
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: 'https://www.youtube.com/watch?v=live0000001' },
      scheduled_start_time: '2026-11-03T11:00:00.000Z',
      scheduled_end_time: '2026-11-03T13:00:00.000Z',
      reason: 'YouTube stream'
    })
  })

  test('the event moves with the stream, starts with it and ends with it', async () => {
    let record = { event_id: 'EV1', status: 'scheduled', scheduled_start: '2026-11-03T11:00:00Z', scheduled_end: '2026-11-03T13:00:00Z' }
    assert.equal(await liveWatcher.follow(bot.guild, stream(), record, NOW), null, 'nothing changed')

    const moved = await liveWatcher.follow(bot.guild, stream({ scheduledStart: '2026-11-03T12:00:00Z' }), record, NOW)
    assert.deepEqual(bot.calls.at(-1), { method: 'PATCH', url: '/guilds/100/scheduled-events/EV1', body: { scheduled_start_time: '2026-11-03T12:00:00.000Z', scheduled_end_time: '2026-11-03T14:00:00.000Z' } })
    record = { event_id: 'EV1', status: moved.status, scheduled_start: moved.scheduledStart, scheduled_end: moved.scheduledEnd }

    const started = await liveWatcher.follow(bot.guild, stream({ liveStatus: 'live' }), record, NOW)
    assert.equal(started.status, 'active')
    assert.deepEqual(bot.calls.at(-1).body, { status: 2 })
    record = { ...record, status: 'active' }

    const ended = await liveWatcher.follow(bot.guild, stream({ liveStatus: 'none', actualStart: 'x', actualEnd: 'y' }), record, NOW)
    assert.equal(ended.status, 'completed')
    assert.deepEqual(bot.calls.at(-1).body, { status: 3 })
  })

  test('a stream that starts unscheduled gets an event started at once', async () => {
    const next = await liveWatcher.follow(bot.guild, stream({ liveStatus: 'live', scheduledStart: null }), undefined, NOW)
    assert.equal(next.status, 'active')
    assert.equal(bot.calls[0].body.scheduled_start_time, '2026-11-01T10:01:00.000Z', 'just ahead of now, as Discord requires')
    assert.deepEqual(bot.calls[1], { method: 'PATCH', url: `/guilds/100/scheduled-events/${next.eventID}`, body: { status: 2 } })
  })

  test('a running stream keeps its event open past the planned end', async () => {
    const record = { event_id: 'EV1', status: 'active', scheduled_end: '2026-11-01T10:10:00Z' }
    const next = await liveWatcher.follow(bot.guild, stream({ liveStatus: 'live' }), record, NOW)
    assert.deepEqual(bot.calls.at(-1).body, { scheduled_end_time: '2026-11-01T11:00:00.000Z' })
    assert.equal(next.status, 'active')
  })

  test('a stream called off, or deleted, cancels its event; one that ran unseen is completed', async () => {
    const record = { event_id: 'EV1', status: 'scheduled', scheduled_start: '2026-11-03T11:00:00Z' }
    assert.equal((await liveWatcher.follow(bot.guild, stream({ liveStatus: 'none' }), record, NOW)).status, 'canceled')
    assert.deepEqual(bot.calls.at(-1).body, { status: 4 })
    assert.equal((await liveWatcher.follow(bot.guild, null, record, NOW)).status, 'canceled')
    assert.equal((await liveWatcher.follow(bot.guild, stream({ liveStatus: 'none', actualStart: 'x' }), record, NOW)).status, 'completed')
    assert.deepEqual(bot.calls.slice(-2).map(c => c.body), [{ status: 2 }, { status: 3 }])
  })

  test('an ordinary video, or a stream that ended before it was seen, gets nothing', async () => {
    assert.equal(await liveWatcher.follow(bot.guild, stream({ liveStatus: 'none' }), undefined, NOW), null)
    assert.equal(bot.calls.length, 0)
  })

  test('the thumbnail becomes the event cover', async (t) => {
    const sharp = require('sharp')
    const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#ff0000' } }).png().toBuffer()
    t.mock.method(urlFetcher, 'fetchImage', async () => ({ buffer: png }))
    await liveWatcher.follow(bot.guild, stream({ thumbnail: 'https://i.ytimg.com/vi/x/maxresdefault.jpg' }), undefined, NOW)
    assert.match(bot.calls[0].body.image, /^data:image\/jpeg;base64,/)
  })
})

describe('checkGuild', () => {
  let store
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = 'k'
    store = installYouTubeStore({ 100: { channel: { channel_ref: '@x', channel_id: UC, live_events: true }, videos: [{ video_id: 'old00000001', live_status: 'none' }] } })
  })

  // The feed lists `feed`; the API knows `videos`.
  function fakeYouTube (feed, videos) {
    const calls = []
    global.fetch = async url => {
      const u = new URL(url)
      if (u.pathname === '/feeds/videos.xml') {
        calls.push('feed')
        return { ok: true, text: async () => feed.map(id => `<yt:videoId>${id}</yt:videoId>`).join('') }
      }
      calls.push(`videos:${u.searchParams.get('id')}`)
      return { ok: true, json: async () => ({ items: videos.filter(v => u.searchParams.get('id').split(',').includes(v.id)) }) }
    }
    return calls
  }
  const apiVideo = (id, liveBroadcastContent, extra = {}) => ({
    id, snippet: { title: id, description: '', publishedAt: '2026-11-01T00:00:00Z', liveBroadcastContent, thumbnails: {} }, ...extra
  })

  test('a new scheduled stream in the feed becomes an event; an ordinary video uploaded long ago does not', async () => {
    const bot = installBot()
    const calls = fakeYouTube(['stream00001', 'video000001', 'old00000001'], [
      apiVideo('stream00001', 'upcoming', { liveStreamingDetails: { scheduledStartTime: '2099-01-01T00:00:00Z' } }),
      apiVideo('video000001', 'none', { snippet: { title: 'video000001', description: '', publishedAt: '2020-01-01T00:00:00Z', liveBroadcastContent: 'none', thumbnails: {} } })
    ])
    assert.equal(await liveWatcher.checkGuild('100', UC), 1)
    assert.deepEqual(calls, ['feed', 'videos:stream00001,video000001'])
    assert.equal(bot.calls.filter(c => c.method === 'POST').length, 1)
    assert.equal(store.liveEvents[100].stream00001.status, 'scheduled')
    assert.equal(store.liveEvents[100].video000001, undefined)
  })

  test('a new upload becomes an event that starts at once, then is ended when its time is up', async () => {
    const bot = installBot()
    const justNow = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    fakeYouTube(['upload00001'], [apiVideo('upload00001', 'none', { snippet: { title: '新しい動画', description: '説明', publishedAt: justNow, liveBroadcastContent: 'none', thumbnails: {} } })])
    assert.equal(await liveWatcher.checkGuild('100', UC), 1)
    const [created, started] = bot.calls
    assert.equal(created.method, 'POST')
    assert.equal(created.body.name, '📺 新着動画: 新しい動画')
    assert.equal(created.body.reason, 'YouTube upload')
    assert.equal(new Date(created.body.scheduled_end_time) - new Date(created.body.scheduled_start_time), 24 * 3600 * 1000)
    assert.deepEqual(started.body, { status: 2 })
    assert.equal(store.liveEvents[100].upload00001.kind, 'upload')
    assert.equal(store.liveEvents[100].upload00001.status, 'active')

    // Seen again before its end: nothing. After: ended, and its "archive" is never summarized.
    bot.calls.length = 0
    assert.equal(await liveWatcher.checkGuild('100', UC), 0)
    assert.equal(bot.calls.length, 0)
    store.liveEvents[100].upload00001.scheduled_end = new Date(Date.now() - 1000).toISOString()
    assert.equal(await liveWatcher.checkGuild('100', UC), 1)
    assert.deepEqual(bot.calls[0].body, { status: 3 })
    assert.equal(store.liveEvents[100].upload00001.status, 'completed')
    assert.deepEqual(await require('../../src/db/interfaces/postgres/youtube').archivesToSummarize('100'), [])
  })

  test('UPLOAD_EVENTS=false keeps uploads out of events', async () => {
    process.env.UPLOAD_EVENTS = 'false'
    try {
      const bot = installBot()
      fakeYouTube(['upload00002'], [apiVideo('upload00002', 'none', { snippet: { title: 'x', description: '', publishedAt: new Date().toISOString(), liveBroadcastContent: 'none', thumbnails: {} } })])
      assert.equal(await liveWatcher.checkGuild('100', UC), 0)
      assert.equal(bot.calls.length, 0)
    } finally {
      delete process.env.UPLOAD_EVENTS
    }
  })

  test('costs no API quota when nothing is new or followed', async () => {
    installBot()
    const calls = fakeYouTube(['old00000001'], [])
    assert.equal(await liveWatcher.checkGuild('100', UC), 0)
    assert.deepEqual(calls, ['feed'])
  })

  test('an event someone deleted is left alone afterwards', async () => {
    installBot({ gone: ['EV9'] })
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'stream00001', { eventID: 'EV9', status: 'scheduled', scheduledStart: '2099-01-01T00:00:00Z' })
    fakeYouTube([], [apiVideo('stream00001', 'live', { liveStreamingDetails: {} })])
    await liveWatcher.checkGuild('100', UC)
    assert.equal(store.liveEvents[100].stream00001.status, 'gone')
  })

  test('without Manage Events, nothing is made and it says why', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    const bot = installBot({ canManageEvents: false })
    fakeYouTube(['stream00001'], [apiVideo('stream00001', 'upcoming', { liveStreamingDetails: {} })])
    assert.equal(await liveWatcher.checkGuild('100', UC), 0)
    assert.equal(bot.calls.length, 0)
    assert.match(warned.mock.calls[0].arguments[0], /lacks Manage Events/)
  })

  test('checkAll checks every channel the bot follows for the servers that turned it on; a push just its channel', async () => {
    installBot()
    const other = 'UC' + 'g'.repeat(22)
    store.knowledge[200] = { channel: { channel_id: other, live_events: false }, videos: [] }
    const feeds = []
    global.fetch = async url => {
      const u = new URL(url)
      feeds.push(u.searchParams.get('channel_id'))
      return { ok: true, text: async () => '' }
    }
    await liveWatcher.checkAll()
    assert.deepEqual(feeds.sort(), [UC, other].sort(), 'both channels, for server 100 (server 200 has it off)')
    feeds.length = 0
    await liveWatcher.checkAll(other)
    assert.deepEqual(feeds, [other], 'a push checks just its channel')
    feeds.length = 0
    await liveWatcher.checkAll('UC' + 'z'.repeat(22))
    assert.deepEqual(feeds, [], 'a push for a channel the bot does not follow checks nothing')
    store.knowledge[100].channel.live_events = false
    await liveWatcher.checkAll()
    assert.deepEqual(feeds, [], 'no server has it on: nothing is checked')
  })
})
