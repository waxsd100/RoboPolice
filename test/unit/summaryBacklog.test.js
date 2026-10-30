const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installYouTubeStore } = require('../helpers/fakes')
const backlog = require('../../src/bot/modules/summaryBacklog')

// Thursday 2026-10-29 20:00 in Tokyo, 04:00 the same day in Los Angeles.
const NOW = new Date('2026-10-29T11:00:00Z')

const video = (n, duration, extra = {}) => ({
  video_id: `video${String(n).padStart(6, '0')}`,
  title: `動画${n}`,
  url: `https://www.youtube.com/watch?v=video${String(n).padStart(6, '0')}`,
  live_status: 'none',
  duration,
  published_at: new Date(Date.UTC(2026, 0, n)),
  ...extra
})

// Gemini as the backlog sees it: each request records which key it was sent with.
function installGemini ({ rateLimited = [] } = {}) {
  const calls = []
  global.fetch = async (url, init) => {
    const alias = init.headers['cf-aig-byok-alias'] || null
    const videoUri = JSON.parse(init.body).contents[0].parts[0].fileData.fileUri
    calls.push({ alias, video: videoUri.slice(-11) })
    if (rateLimited.includes(alias)) return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'quota' }
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: `要約 ${videoUri.slice(-11)}` }] } }] }) }
  }
  return calls
}

describe('summaryBacklog', () => {
  let store
  beforeEach((t) => {
    configureGateway()
    process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS = 'paid-key'
    t.mock.method(global.logger, 'info', () => {})
    t.mock.method(require('../../src/bot/modules/eventDrafter').retryTimer, 'sleep', async () => {})
  })
  afterEach(() => {
    for (const name of ['VIDEO_SUMMARY_FREE_BYOK_ALIAS', 'YOUTUBE_SUMMARY_FREE_HOURS_PER_DAY', 'YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH', 'CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS']) delete process.env[name]
  })

  test('reads YouTube durations', () => {
    assert.equal(backlog.durationSeconds('PT1H2M3S'), 3723)
    assert.equal(backlog.durationSeconds('PT45S'), 45)
    assert.equal(backlog.durationSeconds('P1DT1H'), 90000)
    assert.equal(backlog.durationSeconds('P0D'), 0)
    assert.equal(backlog.durationSeconds(''), null)
  })

  test('does nothing without a budget', async () => {
    installYouTubeStore({ 100: { channel: {}, videos: [video(1, 'PT10M')] } })
    const calls = installGemini()
    assert.deepEqual(await backlog.runOnce(NOW), { done: 0, failed: 0 })
    assert.equal(calls.length, 0)
  })

  test('uses the free key first, up to its hours for the Pacific day, then the paid key up to its monthly hours', async () => {
    process.env.VIDEO_SUMMARY_FREE_BYOK_ALIAS = 'free-key'
    process.env.YOUTUBE_SUMMARY_FREE_HOURS_PER_DAY = '1'
    process.env.YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH = '1'
    // Newest first: 40 min (free), 30 min (free is full, so paid), 40 min (paid is full too), 10 min (free has 20 left).
    store = installYouTubeStore({ 100: { channel: {}, videos: [video(4, 'PT40M'), video(3, 'PT30M'), video(2, 'PT40M'), video(1, 'PT10M')] } })
    const calls = installGemini()
    assert.deepEqual(await backlog.runOnce(NOW), { done: 3, failed: 0 })
    assert.deepEqual(calls.map(c => [c.video, c.alias]), [['video000004', 'free-key'], ['video000003', 'paid-key'], ['video000001', 'free-key']])
    assert.deepEqual(store.usage, [
      { tier: 'free', day: '2026-10-29', seconds: 2400 },
      { tier: 'paid', day: '2026-10-29', seconds: 1800 },
      { tier: 'free', day: '2026-10-29', seconds: 600 }
    ])
    assert.equal(store.summaries[100].video000004, '要約 video000004')
  })

  test('a rate-limited free key moves on to the paid key', async () => {
    process.env.VIDEO_SUMMARY_FREE_BYOK_ALIAS = 'free-key'
    process.env.YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH = '10'
    installYouTubeStore({ 100: { channel: {}, videos: [video(2, 'PT10M'), video(1, 'PT10M')] } })
    const calls = installGemini({ rateLimited: ['free-key'] })
    assert.deepEqual(await backlog.runOnce(NOW), { done: 2, failed: 0 })
    assert.deepEqual(calls.filter(c => c.alias === 'paid-key').map(c => c.video), ['video000002', 'video000001'])
  })

  test('a video that fails is recorded and given up after two tries; streams and unknown lengths are skipped', async (t) => {
    process.env.YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH = '10'
    store = installYouTubeStore({ 100: { channel: {}, videos: [video(3, 'PT10M', { live_status: 'upcoming' }), video(2, null), video(1, 'PT10M')] } })
    global.fetch = async () => ({ ok: false, status: 400, text: async () => 'video unavailable' })
    assert.deepEqual(await backlog.runOnce(NOW), { done: 0, failed: 1 })
    await backlog.runOnce(NOW)
    assert.deepEqual(await backlog.runOnce(NOW), { done: 0, failed: 0 }, 'given up after two tries')
    assert.deepEqual(store.writes.filter(w => w.summaryFailure).map(w => w.summaryFailure[1]), ['video000001', 'video000001'])
  })

  test('the free day follows Pacific time, the paid month Japan time', () => {
    assert.equal(backlog.freeDay(new Date('2026-10-30T06:00:00Z')), '2026-10-29')
    assert.deepEqual(backlog.paidMonth(new Date('2026-10-31T16:00:00Z')), { first: '2026-11-01', today: '2026-11-01' })
  })
})
