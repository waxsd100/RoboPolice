const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const { summarizeVideo } = require('../../src/bot/modules/videoSummary')

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
