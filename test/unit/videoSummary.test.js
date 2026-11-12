const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini, installYouTubeStore } = require('../helpers/fakes')
const { summarizeVideo, rewriteLegacySummaries } = require('../../src/bot/modules/videoSummary')

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

  test('with force, summarizes again and replaces the stored summary', async () => {
    const requests = installGemini([[{ text: '作り直した要約' }]])
    assert.deepEqual(await summarizeVideo('100', 'https://youtu.be/cachedVid01', { force: true }), { videoID: 'cachedVid01', summary: '作り直した要約', cached: false })
    assert.equal(requests.length, 1)
    assert.equal(store.summaries[100].cachedVid01, '作り直した要約')
  })

  test('hands the video URL to Gemini at low media resolution, and stores the summary', async () => {
    const requests = installGemini([[{ text: '  ・11/3 に記念配信\n・場所は渋谷  ' }]])
    const result = await summarizeVideo('100', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30')
    assert.deepEqual(result, { videoID: 'dQw4w9WgXcQ', summary: '・11/3 に記念配信\n・場所は渋谷', cached: false })
    const [{ url, body }] = requests
    assert.match(url, /models\/gemini-3.8-flash:generateContent$/)
    assert.deepEqual(body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, videoMetadata: { fps: 0.2 } })
    assert.match(body.contents[0].parts[1].text, /出力テンプレート/)
    assert.equal(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW')
    assert.deepEqual(store.writes, [{ saveSummary: ['100', 'dQw4w9WgXcQ'] }])
    assert.equal(store.summaries[100].dQw4w9WgXcQ, '・11/3 に記念配信\n・場所は渋谷')
  })

  test('strips "要約しました！" chatter, headings, and bold, normalizing every video to "- [時間] 内容・結果"', async () => {
    installGemini([[{
      text: [
        'はい、この YouTube 動画の内容を日本語で要約しました！',
        'この配信では月面清掃ゲームをプレイしています。',
        '',
        '### 主な内容とタイムライン',
        '* **[00:00]** **オープニング**: マイク調整完了、ステージ1開始',
        '・[05:12〜08:00] — ステージ1清掃完了、自動回収ドローン解放',
        '1. 【1:02:05】 ボス戦に3回目で勝利、クリア報酬獲得',
        '  - 告知: 11/15 20:00からコラボ配信（ https://example.com/live ）',
        '・エンディングの感想と次回予告（[1:30:00]）',
        '',
        '最後まで盛り上がりのある配信でした。',
        '以上が動画の要約になります！参考になれば幸いです。（240文字）'
      ].join('\n')
    }]])
    const { summary } = await summarizeVideo('100', 'https://youtu.be/fmtCheck001')
    assert.equal(summary, [
      '- [0:00] オープニング: マイク調整完了、ステージ1開始',
      '- [5:12] ステージ1清掃完了、自動回収ドローン解放',
      '- [1:02:05] ボス戦に3回目で勝利、クリア報酬獲得 / 告知: 11/15 20:00からコラボ配信（ https://example.com/live ）',
      '- [1:30:00] エンディングの感想と次回予告'
    ].join('\n'))
  })

  test('caps very long summaries', async () => {
    installGemini([[{ text: 'あ'.repeat(5000) }]])
    assert.equal((await summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ')).summary.length, 3000)
  })

  test('rejects links that are not YouTube videos', async () => {
    await assert.rejects(summarizeVideo('100', 'https://www.youtube.com/@nobaman'), /動画リンクではありません/)
  })

  test('fails with a hint when Gemini returns no text or only chatter, and stores nothing', async () => {
    installGemini([[{ text: '   ' }], [{ text: 'はい、動画の内容を要約しました！' }]])
    await assert.rejects(summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ'), { hint: 'AI が動画を要約できませんでした' })
    await assert.rejects(summarizeVideo('100', 'https://youtu.be/dQw4w9WgXcQ'), { hint: 'AI が動画を要約できませんでした' })
    assert.deepEqual(store.writes, [])
  })
})

describe('videos too long for one request', () => {
  const TOO_LONG = new Error('{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576."}}')
  const INVALID_ARG = new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}')
  const { retryTimer } = require('../../src/bot/modules/eventDrafter')

  test('stored multi-hour archives (6h+) skip the whole-video request, summarize two hours at a time, shift timestamps, and merge', async (t) => {
    configureGateway()
    const store = installYouTubeStore({ 100: { channel: {}, videos: [{ video_id: 'sZMjbROyaSs', duration: 'PT6H15M' }] } })
    t.mock.method(global.logger, 'info', () => {})
    let started = 0
    const requests = installGemini([
      [{ text: '- [0:00] 挨拶\n- [1:05:00] 序盤の自動化' }],
      [{ text: '- [10:00] 中盤の掃除' }],
      [{ text: '- [45:00] 終盤の設備拡張' }],
      [{ text: '- [0:30] エンディング告知' }],
      body => [{ text: body.contents[0].parts[0].text.match(/\[\d[^\]]*\] [^\n]+/g).join('\n') }]
    ])
    const { summary } = await summarizeVideo('100', 'https://youtu.be/sZMjbROyaSs', { flex: true, onStart: () => { started++ } })
    assert.equal(started, 1)
    assert.equal(requests.length, 5, '4 two-hour clips + 1 light-model merge, with no wasted unclipped call')
    const clips = requests.slice(0, 4).map(r => r.body.contents[0].parts[0].videoMetadata)
    assert.deepEqual(clips, [
      { fps: 0.2, startOffset: '0s', endOffset: '7200s' },
      { fps: 0.2, startOffset: '7200s', endOffset: '14400s' },
      { fps: 0.2, startOffset: '14400s', endOffset: '21600s' },
      { fps: 0.2, startOffset: '21600s', endOffset: '22500s' }
    ])
    assert.match(requests[2].body.contents[0].parts[1].text, /4:00:00〜6:00:00 の区間だけ/)
    assert.match(requests[0].url, /gemini-3\.8-flash:generateContent/)
    assert.match(requests.at(-1).url, /gemini-3\.5-flash-lite:generateContent/, 'putting the parts together needs no video model')
    assert.equal(requests.at(-1).body.serviceTier, 'flex')
    assert.equal(summary, '- [0:00] 挨拶\n- [1:05:00] 序盤の自動化\n- [2:10:00] 中盤の掃除\n- [4:45:00] 終盤の設備拡張\n- [6:00:30] エンディング告知')
    assert.equal(store.summaries[100].sZMjbROyaSs, summary)
  })

  test('falls back to parts when an unstored 6-hour video fails with "Request contains an invalid argument."', async (t) => {
    configureGateway()
    process.env.YOUTUBE_API_KEY = 'yt-key'
    const store = installYouTubeStore()
    t.mock.method(global.logger, 'info', () => {})
    t.mock.method(retryTimer, 'sleep', async () => {})
    const geminiTurns = [
      INVALID_ARG,
      [{ text: '- [0:00] 前半' }],
      INVALID_ARG, // transient glitch on clip 2, retried once and succeeds
      [{ text: '- [15:00] 中盤' }],
      [{ text: '- [30:00] 後半' }],
      body => [{ text: body.contents[0].parts[0].text.match(/\[\d[^\]]*\] [^\n]+/g).join('\n') }]
    ]
    let turn = 0
    const requests = []
    global.fetch = async (url, init = {}) => {
      if (url.includes('googleapis.com/youtube')) {
        return { ok: true, json: async () => ({ items: [{ id: 'd6BAt1Kb7c0', snippet: { title: 'ギルド', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { duration: 'PT6H' } }] }) }
      }
      const body = JSON.parse(init.body)
      requests.push({ url, body })
      const next = geminiTurns[turn++]
      if (next instanceof Error) return { ok: false, status: 400, text: async () => next.message }
      const parts = typeof next === 'function' ? next(body) : next
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) }
    }
    try {
      const { summary } = await summarizeVideo('100', 'https://youtu.be/d6BAt1Kb7c0')
      assert.equal(summary, '- [0:00] 前半\n- [2:15:00] 中盤\n- [4:30:00] 後半')
      assert.equal(store.summaries[100].d6BAt1Kb7c0, summary)
      assert.equal(requests.length, 6, '1 unclipped + 3 clips (clip 2 retried once) + 1 merge')
    } finally {
      process.env.YOUTUBE_API_KEY = ''
    }
  })

  test('steps down to 1-hour parts when a 2-hour video or clip still exceeds limits', async (t) => {
    configureGateway()
    const store = installYouTubeStore({ 100: { channel: {}, videos: [{ video_id: 'twoHourVid1', duration: 'PT2H' }] } })
    t.mock.method(global.logger, 'info', () => {})
    t.mock.method(retryTimer, 'sleep', async () => {})
    const requests = installGemini([
      INVALID_ARG,
      [{ text: '- [0:00] 1時間目' }],
      [{ text: '- [05:00] 2時間目' }],
      body => [{ text: body.contents[0].parts[0].text.match(/\[\d[^\]]*\] [^\n]+/g).join('\n') }]
    ])
    const { summary } = await summarizeVideo('100', 'https://youtu.be/twoHourVid1')
    const clips = requests.slice(1, 3).map(r => r.body.contents[0].parts[0].videoMetadata)
    assert.deepEqual(clips, [
      { fps: 0.2, startOffset: '0s', endOffset: '3600s' },
      { fps: 0.2, startOffset: '3600s', endOffset: '7200s' }
    ])
    assert.equal(summary, '- [0:00] 1時間目\n- [1:05:00] 2時間目')
    assert.equal(store.summaries[100].twoHourVid1, summary)
  })

  test('VIDEO_SUMMARY_FPS sets the frames a second; the parts are put together by the lighter model', async () => {
    process.env.VIDEO_SUMMARY_FPS = '1'
    const requests = installGemini([[{ text: '要約' }]])
    await summarizeVideo('100', 'https://youtu.be/fpsCheck001')
    assert.deepEqual(requests[0].body.contents[0].parts[0].videoMetadata, { fps: 1 })
    assert.match(requests[0].url, /gemini-3.8-flash:generateContent/)
    delete process.env.VIDEO_SUMMARY_FPS
  })

  test('say so when the length is not known', async (t) => {
    configureGateway()
    installYouTubeStore()
    t.mock.method(global.logger, 'info', () => {})
    delete process.env.YOUTUBE_API_KEY
    installGemini([TOO_LONG])
    await assert.rejects(summarizeVideo('100', 'https://youtu.be/unknownLen1'), { hint: '動画が長すぎて一度に読めず、長さも分からないため要約できませんでした' })
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

describe('existing summaries (migration 050 + lightweight AI rewrite)', () => {
  const { retryTimer, GeminiError } = require('../../src/bot/modules/eventDrafter')
  const applyMigration050 = require('../../src/db/migrations/050_youtube_summary_format')

  test('migration 050 cleans chatter, headings, bold, and irregular timestamps from existing DB rows and drops chatter-only rows', async () => {
    const dbRows = new Map([
      ['v1', 'はい、要約しました！\n### まとめ\n* **[00:05]** 挨拶とマイクテスト完了\n以上です。（45文字）'],
      ['v2', '- [0:00] 既に整っている要約'],
      ['v3', 'はい、この動画の内容を要約しました！']
    ])
    const sqlLog = []
    const fakeClient = {
      query: async (sql, params = []) => {
        sqlLog.push(sql)
        if (/SELECT video_id, summary FROM youtube_summaries/.test(sql)) {
          const [after, limit] = params
          const rows = [...dbRows.entries()]
            .filter(([id]) => id > after)
            .sort(([a], [b]) => a.localeCompare(b))
            .slice(0, limit)
            .map(([id, summary]) => ({ video_id: id, summary }))
          return { rows }
        }
        if (/^UPDATE youtube_summaries/.test(sql)) {
          for (const [, id, text] of sql.matchAll(/\('([^']+)', '([^']+)'\)/g)) {
            dbRows.set(id, text)
          }
          return { rowCount: 1 }
        }
        if (/^DELETE FROM youtube_summaries/.test(sql)) {
          for (const id of params[0]) dbRows.delete(id)
          return { rowCount: params[0].length }
        }
        return { rows: [] }
      }
    }
    await applyMigration050(fakeClient)
    assert.ok(sqlLog.some(s => /ADD COLUMN IF NOT EXISTS format_version/.test(s) && /COMMENT ON COLUMN youtube_summaries\.format_version/.test(s)))
    assert.equal(dbRows.get('v1'), '- [0:05] 挨拶とマイクテスト完了')
    assert.equal(dbRows.get('v2'), '- [0:00] 既に整っている要約')
    assert.equal(dbRows.has('v3'), false, 'chatter-only broken row is deleted')
  })

  test('rewriteLegacySummaries rewrites legacy v1 summaries newest-first on light Flex model, skips v2, and never clobbers concurrent force updates', async (t) => {
    configureGateway()
    t.mock.method(global.logger, 'info', () => {})
    t.mock.method(retryTimer, 'sleep', async () => {})
    const store = installYouTubeStore(
      {
        100: {
          channel: { channel_id: 'UC1', title: 'Ch' },
          videos: [
            { video_id: 'oldVid00001', published_at: '2026-09-01T00:00:00Z' },
            { video_id: 'newVid00002', published_at: '2026-10-15T00:00:00Z' },
            { video_id: 'alreadyV2_3', published_at: '2026-10-20T00:00:00Z' }
          ]
        }
      },
      {
        100: {
          oldVid00001: 'オープニングで挨拶について話しています。その後ボスに勝利しました。',
          newVid00002: '- [0:00] 冒頭ではルールについて説明しています。\n- [15:20] 決勝戦で優勝という結果になりました。'
        }
      }
    )
    const youtubeDB = require('../../src/db/interfaces/postgres/youtube')
    await youtubeDB.saveSummary('100', 'alreadyV2_3', '- [0:00] 既にv2の要約', 2)

    const requests = installGemini([
      [{ text: '要約しました！\n- [0:00] ルール説明\n- [15:20] 決勝戦で優勝' }],
      [{ text: '- オープニング挨拶\n- ボス戦に勝利' }]
    ])

    const res = await rewriteLegacySummaries({ batchSize: 1 })
    assert.deepEqual(res, { rewritten: 2, retry: false })
    assert.equal(requests.length, 2, 'only legacy v1 summaries are rewritten; v2 is untouched')
    assert.match(requests[0].url, /gemini-3\.5-flash-lite:generateContent$/, 'uses cheap text light model')
    assert.equal(requests[0].body.serviceTier, 'flex', 'uses half-price Flex tier')
    assert.match(requests[0].body.contents[0].parts[0].text, /15:20/, 'newest legacy video is rewritten first')
    assert.equal(store.summaries[100].newVid00002, '- [0:00] ルール説明\n- [15:20] 決勝戦で優勝')
    assert.equal(store.summaries[100].oldVid00001, '- オープニング挨拶\n- ボス戦に勝利')
    assert.equal(store.summaries[100].alreadyV2_3, '- [0:00] 既にv2の要約')

    // A second pass finds 0 legacy rows and makes 0 API calls.
    assert.deepEqual(await rewriteLegacySummaries(), { rewritten: 0, retry: false })
    assert.equal(requests.length, 2)
  })

  test('rewriteLegacySummaries falls back to cleaned text when blocked, and does not overwrite a summary replaced mid-flight', async (t) => {
    configureGateway()
    t.mock.method(global.logger, 'info', () => {})
    t.mock.method(retryTimer, 'sleep', async () => {})
    const store = installYouTubeStore({}, {
      100: {
        blockedVid1: 'はい、要約しました！\n* **[01:00]** 下ネタトークで盛り上がる',
        racedVid002: '- [0:00] 古い文面について話しています'
      }
    })
    const youtubeDB = require('../../src/db/interfaces/postgres/youtube')
    let turn = 0
    global.fetch = async () => {
      turn++
      if (turn === 1) {
        return { ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, candidates: [] }) }
      }
      // Simulate a concurrent /youtube summarize force:True completing while rewrite is in flight
      await youtubeDB.saveSummary('100', 'racedVid002', '- [0:00] forceで再生成した最新要約', 2)
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '- [0:00] 旧要約の書き換え' }] } }] }) }
    }
    assert.ok(GeminiError)
    const res = await rewriteLegacySummaries({ batchSize: 10 })
    assert.equal(res.retry, false)
    assert.equal(store.summaries[100].blockedVid1, '- [1:00] 下ネタトークで盛り上がる', 'blocked row keeps cleaned summary and advances to v2')
    assert.equal(store.summaries[100].racedVid002, '- [0:00] forceで再生成した最新要約', 'concurrent force:True summary is preserved')
    assert.deepEqual(await youtubeDB.legacySummaries(2, 10), [])
  })
})
