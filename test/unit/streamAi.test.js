// Stream events (no AI blurbs or game link lookups) and archive summaries afterwards.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const liveWatcher = require('../../src/bot/modules/liveWatcher')

const video = (extra = {}) => ({
  id: 'live0000001',
  title: '【マイクラ】城を建てる',
  description: '今日はみんなで城づくり。ゲスト：〇〇さん',
  url: 'https://www.youtube.com/watch?v=live0000001',
  liveStatus: 'upcoming',
  scheduledStart: '2026-11-03T11:00:00Z',
  isStream: true,
  thumbnail: 'https://i.ytimg.com/vi/live0000001/maxresdefault.jpg',
  ...extra
})

const GATEWAY = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID', 'GEMINI_API_KEY']
afterEach(() => {
  for (const name of [...GATEWAY, 'LIVE_ARCHIVE_SUMMARY', 'YOUTUBE_API_KEY']) delete process.env[name]
})

describe('the event of a stream', () => {
  test('creates events with zero Gemini calls using only the stream description and URL', async (t) => {
    configureGateway()
    t.mock.method(urlFetcher, 'fetchImage', async () => { throw new Error('no thumbnail here') })
    const requests = installGemini([])
    const calls = []
    global.bot = { requestHandler: { request: async (method, url, auth, body) => { calls.push(body); return { id: 'EV0' } } } }
    try {
      await liveWatcher.follow({ id: '100' }, video(), undefined, new Date('2026-11-01T00:00:00Z'))
      assert.equal(requests.length, 0)
      assert.equal(calls[0].description, '今日はみんなで城づくり。ゲスト：〇〇さん\n\nhttps://www.youtube.com/watch?v=live0000001')
    } finally {
      delete global.bot
    }
  })

  test('a long description is cut to fit Discord\'s 1000 characters, the URL kept', () => {
    const text = liveWatcher.eventDescription(video({ description: 'あ'.repeat(2000) }))
    assert.equal(text.length, 1000)
    assert.ok(text.startsWith('あああ'))
    assert.ok(text.endsWith('…\n\nhttps://www.youtube.com/watch?v=live0000001'))
    assert.equal(liveWatcher.eventDescription(video({ description: '' })), 'https://www.youtube.com/watch?v=live0000001')
  })
})

describe('summarizing a stream\'s archive', () => {
  let store
  beforeEach(() => {
    configureGateway()
    store = installYouTubeStore({ 100: { channel: { channel_ref: '@x', channel_id: 'UC' + 'f'.repeat(22) }, videos: [] } })
  })

  test('when LIVE_ARCHIVE_SUMMARY=true, a completed stream is summarized like any video, once', async (t) => {
    process.env.LIVE_ARCHIVE_SUMMARY = 'true'
    t.mock.method(global.logger, 'info', () => {})
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000001', { eventID: 'EV1', status: 'completed' })
    const requests = installGemini([[{ text: '配信の要約' }]])
    assert.equal(await liveWatcher.summarizeArchives('100'), 'live0000001')
    assert.match(requests[0].body.contents[0].parts[0].fileData.fileUri, /watch\?v=live0000001$/)
    assert.equal(requests[0].body.serviceTier, 'flex', 'stream archives are summarized on Flex')
    assert.equal(store.summaries[100].live0000001, '配信の要約')
    assert.equal(await liveWatcher.summarizeArchives('100'), null, 'nothing left')
  })

  test('a failure counts as a try, and three tries are the most', async (t) => {
    process.env.LIVE_ARCHIVE_SUMMARY = 'true'
    t.mock.method(global.logger, 'warn', () => {})
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000002', { eventID: 'EV2', status: 'completed' })
    installGemini([new Error('not ready'), new Error('not ready'), new Error('not ready')])
    for (let i = 0; i < 3; i++) assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(store.archiveAttempts.live0000002, 3)
    const requests = installGemini([])
    assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(requests.length, 0)
  })

  test('nothing is summarized by default or when turned off', async () => {
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000003', { eventID: 'EV3', status: 'completed' })
    delete process.env.LIVE_ARCHIVE_SUMMARY
    const requests = installGemini([])
    assert.equal(await liveWatcher.summarizeArchives('100'), null, 'off by default')
    process.env.LIVE_ARCHIVE_SUMMARY = 'false'
    assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(requests.length, 0)
  })
})
