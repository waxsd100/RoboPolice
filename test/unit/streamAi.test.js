// The AI's line on what a stream is about, in its event, and the summary of its archive afterwards.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const { describeStream } = require('../../src/bot/modules/streamBlurb')
const liveWatcher = require('../../src/bot/modules/liveWatcher')
const gameLinks = require('../../src/bot/modules/gameLinks')

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
  for (const name of [...GATEWAY, 'LIVE_EVENT_AI_DESCRIPTION', 'LIVE_ARCHIVE_SUMMARY']) delete process.env[name]
})

describe('describeStream', () => {
  beforeEach(() => configureGateway())

  test('asks Gemini with the title, the description and the thumbnail, for a line and the games played', async (t) => {
    const requests = installGemini([[{ text: JSON.stringify({ blurb: 'ゲストと一緒にマイクラで城を建てる配信。（20文字）', games: [{ name: 'マインクラフト', name_en: 'Minecraft' }, { name: ' ' }] }) }]])
    const looked = t.mock.method(gameLinks, 'linksFor', async games => games.map(g => ({ name: g.name, url: 'https://www.minecraft.net/' })))
    const described = await describeStream(video(), { buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg' })
    assert.deepEqual(described, { blurb: 'ゲストと一緒にマイクラで城を建てる配信。', games: [{ name: 'マインクラフト', url: 'https://www.minecraft.net/' }] })
    assert.deepEqual(looked.mock.calls[0].arguments[0], [{ name: 'マインクラフト', nameEn: 'Minecraft' }])
    assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json')
    const [text, image] = requests[0].body.contents[0].parts
    assert.match(text.text, /タイトル: 【マイクラ】城を建てる\n概要欄:\n今日はみんなで城づくり/)
    assert.deepEqual(image, { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') } })
  })

  test('gives nothing when Gemini fails, when turned off, or without a gateway', async (t) => {
    t.mock.method(global.logger, 'warn', () => {})
    installGemini([new Error('boom')])
    assert.equal(await describeStream(video()), null)
    process.env.LIVE_EVENT_AI_DESCRIPTION = 'false'
    const requests = installGemini([])
    assert.equal(await describeStream(video()), null)
    delete process.env.LIVE_EVENT_AI_DESCRIPTION
    for (const name of GATEWAY) delete process.env[name]
    assert.equal(await describeStream(video()), null)
    assert.equal(requests.length, 0)
  })
})

describe('the event of a stream', () => {
  test('starts with what the AI says and the games\' pages, then the stream\'s own description and its URL', async (t) => {
    configureGateway()
    t.mock.method(urlFetcher, 'fetchImage', async () => { throw new Error('no thumbnail here') })
    t.mock.method(gameLinks, 'linksFor', async () => [{ name: 'マインクラフト', url: 'https://store.steampowered.com/app/1/' }])
    installGemini([[{ text: JSON.stringify({ blurb: 'マイクラで城を建てる配信。', games: [{ name: 'マインクラフト' }] }) }]])
    const calls = []
    global.bot = { requestHandler: { request: async (method, url, auth, body) => { calls.push(body); return { id: 'EV1' } } } }
    await liveWatcher.follow({ id: '100' }, video(), undefined, new Date('2026-11-01T00:00:00Z'))
    assert.equal(calls[0].description, 'マイクラで城を建てる配信。\n\n🎮 マインクラフト: https://store.steampowered.com/app/1/\n\n今日はみんなで城づくり。ゲスト：〇〇さん\n\nhttps://www.youtube.com/watch?v=live0000001')
    delete global.bot
  })

  test('a long description is cut to fit Discord\'s 1000 characters, the URL kept', () => {
    const text = liveWatcher.eventDescription(video({ description: 'あ'.repeat(2000) }), '説明')
    assert.equal(text.length, 1000)
    assert.ok(text.startsWith('説明\n\nあ'))
    assert.ok(text.endsWith('…\n\nhttps://www.youtube.com/watch?v=live0000001'))
    assert.equal(liveWatcher.eventDescription(video({ description: '' }), null), 'https://www.youtube.com/watch?v=live0000001')
  })
})

describe('summarizing a stream\'s archive', () => {
  let store
  beforeEach(() => {
    configureGateway()
    store = installYouTubeStore({ 100: { channel: { channel_ref: '@x', channel_id: 'UC' + 'f'.repeat(22) }, videos: [] } })
  })

  test('a completed stream is summarized like any video, once', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000001', { eventID: 'EV1', status: 'completed' })
    const requests = installGemini([[{ text: '配信の要約' }]])
    assert.equal(await liveWatcher.summarizeArchives('100'), 'live0000001')
    assert.match(requests[0].body.contents[0].parts[0].fileData.fileUri, /watch\?v=live0000001$/)
    assert.equal(store.summaries[100].live0000001, '配信の要約')
    assert.equal(await liveWatcher.summarizeArchives('100'), null, 'nothing left')
  })

  test('a failure counts as a try, and three tries are the most', async (t) => {
    t.mock.method(global.logger, 'warn', () => {})
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000002', { eventID: 'EV2', status: 'completed' })
    installGemini([new Error('not ready'), new Error('not ready'), new Error('not ready')])
    for (let i = 0; i < 3; i++) assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(store.liveEvents[100].live0000002.archive_attempts, 3)
    const requests = installGemini([])
    assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(requests.length, 0)
  })

  test('nothing is summarized when it is turned off', async () => {
    await require('../../src/db/interfaces/postgres/youtube').saveLiveEvent('100', 'live0000003', { eventID: 'EV3', status: 'completed' })
    process.env.LIVE_ARCHIVE_SUMMARY = 'false'
    const requests = installGemini([])
    assert.equal(await liveWatcher.summarizeArchives('100'), null)
    assert.equal(requests.length, 0)
  })
})
