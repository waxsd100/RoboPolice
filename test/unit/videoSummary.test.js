const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const { summarizeVideo } = require('../../src/bot/modules/videoSummary')

// Node's own fetch, before tests replace global.fetch with fakes.
const realFetch = globalThis.fetch

describe('summarizeVideo', () => {
  let store
  beforeEach(() => {
    configureGateway()
    store = installYouTubeStore({}, { 100: { cachedVid01: '保存済みの要約' } })
  })

  test('returns a stored summary without calling Gemini', async () => {
    const requests = installGemini([])
    assert.deepEqual(await summarizeVideo('100', 'https://youtu.be/cachedVid01'), { videoID: 'cachedVid01', summary: '保存済みの要約', cached: true })
    assert.equal(requests.length, 0)
  })

  test('hands the video URL to Gemini at low media resolution, and stores the summary', async () => {
    const requests = installGemini([[{ text: '  ・11/3 に記念配信\n・場所は渋谷  ' }]])
    const result = await summarizeVideo('100', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30')
    assert.deepEqual(result, { videoID: 'dQw4w9WgXcQ', summary: '・11/3 に記念配信\n・場所は渋谷', cached: false })
    const [{ url, body }] = requests
    assert.match(url, /models\/gemini-flash-latest:generateContent$/)
    assert.deepEqual(body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
    assert.match(body.contents[0].parts[1].text, /要約してください/)
    assert.equal(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW')
    assert.deepEqual(store.writes, [{ saveSummary: ['100', 'dQw4w9WgXcQ'] }])
    assert.equal(store.summaries[100].dQw4w9WgXcQ, '・11/3 に記念配信\n・場所は渋谷')
  })

  test('caps very long summaries', async () => {
    installGemini([[{ text: 'あ'.repeat(5000) }]])
    assert.equal((await summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ')).summary.length, 3000)
  })

  test('rejects links that are not YouTube videos', async () => {
    await assert.rejects(summarizeVideo('100', 'https://www.youtube.com/@nobaman'), /動画リンクではありません/)
  })

  test('fails with a hint when Gemini returns no text, and stores nothing', async () => {
    installGemini([[{ text: '   ' }]])
    await assert.rejects(summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ'), { hint: 'AI が動画を要約できませんでした' })
    assert.deepEqual(store.writes, [])
  })
})

describe('waiting for long videos', () => {
  const { Agent } = require('undici')
  beforeEach(() => {
    configureGateway()
    installYouTubeStore()
    delete process.env.VIDEO_SUMMARY_TIMEOUT_MINUTES
  })

  test('waits up to 10 minutes by default, with a dispatcher that lifts fetch\'s 5-minute limit', async () => {
    const seen = []
    global.fetch = async (url, init) => {
      seen.push(init)
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '要約' }] } }] }) }
    }
    let announced
    await summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ', { onStart: ms => { announced = ms } })
    assert.equal(announced, 10 * 60 * 1000)
    assert.ok(seen[0].dispatcher instanceof Agent)
  })

  test('VIDEO_SUMMARY_TIMEOUT_MINUTES changes the limit', async () => {
    process.env.VIDEO_SUMMARY_TIMEOUT_MINUTES = '20'
    installGemini([[{ text: '要約' }]])
    let announced
    await summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ', { onStart: ms => { announced = ms } })
    assert.equal(announced, 20 * 60 * 1000)
  })

  test('onStart is not called for a stored summary', async () => {
    installYouTubeStore({}, { 100: { dQw4w9WgXcQ: '保存済み' } })
    let called = false
    await summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ', { onStart: () => { called = true } })
    assert.equal(called, false)
  })
})

describe('the assumption the long wait relies on', () => {
  // fetch must apply a dispatcher's timeouts; otherwise its own 5-minute headersTimeout would end
  // every long summary early, whatever VIDEO_SUMMARY_TIMEOUT_MINUTES says.
  test('Node\'s fetch applies the headersTimeout of the dispatcher it is given', async () => {
    const http = require('http')
    const { Agent } = require('undici')
    const server = http.createServer((req, res) => setTimeout(() => res.end('late'), 3000))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await assert.rejects(
        realFetch(`http://127.0.0.1:${server.address().port}`, { dispatcher: new Agent({ headersTimeout: 1000 }) }),
        e => e.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
      )
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
