const { test, describe, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const {
  configureGateway,
  installEmbeddingModel,
  installEmbeddingStore,
  installYouTubeStore,
  installGemini,
  installBot,
  installLoreStore,
  installEmojiStore,
  installStreamerStyleStore,
  createGuild,
  createMember
} = require('../helpers/fakes')
const youtubeKnowledge = require('../../src/bot/modules/youtubeKnowledge')
const wikiKnowledge = require('../../src/bot/modules/wikiKnowledge')
const videoSummary = require('../../src/bot/modules/videoSummary')
const { describeServer } = require('../../src/bot/modules/eventTools')
const { hashOf } = require('../../src/db/interfaces/postgres/wiki')
const wikiStore = require('../../src/db/interfaces/postgres/wiki')
const xStore = require('../../src/db/interfaces/postgres/xKnowledge')
const discordStore = require('../../src/db/interfaces/postgres/discordKnowledge')
const webStore = require('../../src/db/interfaces/postgres/webKnowledge')
const youtubeStore = require('../../src/db/interfaces/postgres/youtubeKnowledge')

afterEach(() => {
  process.env.YOUTUBE_CHANNELS = ''
  process.env.WIKI_URLS = ''
  delete process.env.YOUTUBE_KNOWLEDGE_CAPTION_VIDEOS
  mock.restoreAll()
})

describe('youtubeKnowledge', () => {
  test('cleanVideoDescription strips recurring promo/credit/agency footers while keeping video-specific context', () => {
    const raw = [
      '今回は Cities: Skylines で信号を1つも置かずに人口10万人の円形都市を作れるか検証します。',
      '使用MOD: Traffic Manager President Edition',
      '==============================',
      'チャンネル登録よろしくお願いします！ https://www.youtube.com/@nobamangames',
      'Twitter: https://twitter.com/nobamangames',
      'BGM: DOVA-SYNDROME / 効果音ラボ',
      'ビジネス関係のお問い合わせはこちら: UUUM株式会社',
      '#のばまん #CitiesSkylines #ゲーム実況'
    ].join('\n')

    const cleaned = youtubeKnowledge.cleanVideoDescription(raw)
    assert.match(cleaned, /Cities: Skylines で信号を1つも置かずに人口10万人の円形都市/)
    assert.match(cleaned, /Traffic Manager President Edition/)
    assert.doesNotMatch(cleaned, /チャンネル登録|Twitter|DOVA-SYNDROME|効果音ラボ|UUUM|#のばまん/)
  })

  test('refresh ingests summarized and caption-backed videos, skips unchanged pages, and upgrades caption pages when a summary arrives', async (t) => {
    process.env.YOUTUBE_CHANNELS = 'UCTW2tw0Mhho72MojB1L48IQ'
    const pages = new Map()
    let saveCount = 0
    let deletedArgs = null

    t.mock.method(youtubeStore, 'savePage', async (url, title, sections) => {
      saveCount++
      pages.set(url, {
        title,
        sections,
        hashes: sections.map(s => hashOf(`${s.heading}\n${s.text}`))
      })
    })
    t.mock.method(youtubeStore, 'pageSectionHashes', async () => {
      return new Map([...pages.entries()].map(([url, p]) => [url, p.hashes]))
    })
    t.mock.method(youtubeStore, 'deletePagesExcept', async (prefix, urls) => {
      deletedArgs = { prefix, urls }
      return 0
    })

    const summaries = { 100: { vidSum00001: '- [0:00] 円形都市にラウンドアバウトを三重に配置し渋滞率92%達成' } }
    installYouTubeStore({
      100: {
        channel: { channel_id: 'UCTW2tw0Mhho72MojB1L48IQ', title: 'のばまんゲームス', synced_at: new Date('2026-11-15T00:00:00Z') },
        videos: [
          {
            video_id: 'vidSum00001',
            title: '信号ゼロの円形都市を作る',
            description: '高速道路を渦巻き状に接続して渋滞が消えるか実験します。\nチャンネル登録よろしく！',
            live_status: 'none',
            published_at: new Date('2026-11-10T09:00:00Z')
          },
          {
            video_id: 'vidCap00002',
            title: 'ブラックホールで太陽系を壊す実験',
            description: 'チャンネル登録お願いします',
            live_status: 'none',
            published_at: new Date('2026-11-12T09:00:00Z')
          },
          {
            video_id: 'vidEmpty003',
            title: '短い告知',
            description: 'Twitter https://x.com/test',
            live_status: 'none',
            published_at: new Date('2026-11-13T09:00:00Z')
          }
        ]
      }
    }, summaries)

    const captionCalls = []
    const fetchCaptions = async (videoID) => {
      captionCalls.push(videoID)
      if (videoID === 'vidCap00002') {
        return {
          utterances: ['太陽の隣に木星質量のブラックホールを置くと地球の公転軌道が3日で吹き飛ぶことが分かりました'],
          isAuto: false,
          source: 'captions'
        }
      }
      return { utterances: [], isAuto: false, source: 'none' }
    }

    const firstSaved = await youtubeKnowledge.refresh({ fetchCaptions, delayMs: 0 })
    assert.equal(firstSaved, 2, 'saves summarized video + caption-backed video, skipping empty no-caption video')
    assert.deepEqual(captionCalls, ['vidEmpty003', 'vidCap00002'])

    const sumPage = pages.get('https://www.youtube.com/watch?v=vidSum00001')
    assert.equal(sumPage.title, '信号ゼロの円形都市を作る（YouTube 動画）')
    assert.equal(sumPage.sections[0].heading, '動画の内容')
    assert.match(sumPage.sections[0].text, /ラウンドアバウトを三重に配置/)
    assert.match(sumPage.sections[0].text, /渦巻き状に接続/)
    assert.doesNotMatch(sumPage.sections[0].text, /チャンネル登録/)

    const capPage = pages.get('https://www.youtube.com/watch?v=vidCap00002')
    assert.equal(capPage.sections[0].heading, '字幕・概要欄')
    assert.match(capPage.sections[0].text, /地球の公転軌道が3日で吹き飛ぶ/)
    assert.equal(pages.has('https://www.youtube.com/watch?v=vidEmpty003'), false)
    assert.equal(deletedArgs.prefix, 'https://www.youtube.com/watch?v=')
    assert.equal(deletedArgs.urls.length, 3)

    // Second pass with nothing changed: skips both summarized and already-ingested caption videos.
    captionCalls.length = 0
    const secondSaved = await youtubeKnowledge.refresh({ fetchCaptions, delayMs: 0 })
    assert.equal(secondSaved, 0)
    assert.deepEqual(captionCalls, ['vidEmpty003'], 'already-saved caption video is not re-fetched')
    assert.equal(saveCount, 2)

    // Once vidCap00002 gets a full Gemini summary, refresh upgrades its page from captions to full summary.
    summaries[100].vidCap00002 = '- [2:15] 太陽の横にブラックホールを出現させ地球が太陽系外へ弾き飛ばされることを確認'
    const upgraded = await youtubeKnowledge.refresh({ fetchCaptions, delayMs: 0 })
    assert.equal(upgraded, 1)
    assert.equal(pages.get('https://www.youtube.com/watch?v=vidCap00002').sections[0].heading, '動画の内容')
    assert.match(pages.get('https://www.youtube.com/watch?v=vidCap00002').sections[0].text, /太陽系外へ弾き飛ばされる/)
  })

  test('storeSummary immediately ingests followed-channel summaries and ignores external videos', async (t) => {
    process.env.YOUTUBE_CHANNELS = 'UCTW2tw0Mhho72MojB1L48IQ'
    configureGateway()
    installEmbeddingModel()

    installYouTubeStore({
      100: {
        channel: { channel_id: 'UCTW2tw0Mhho72MojB1L48IQ', title: 'のばまんゲームス', synced_at: new Date('2026-11-15T00:00:00Z') },
        videos: [
          {
            video_id: 'vidOwn00001',
            title: 'アリ塚シミュレーション実験',
            description: '',
            live_status: 'none',
            published_at: new Date('2026-11-14T09:00:00Z')
          }
        ]
      }
    })

    const savedPages = []
    const savedFacts = []
    for (const s of [wikiStore, xStore, discordStore, webStore]) {
      t.mock.method(s, 'sectionsToExtract', async () => [])
      t.mock.method(s, 'sectionsToEmbed', async () => [])
      t.mock.method(s, 'factsToEmbed', async () => [])
    }
    t.mock.method(youtubeStore, 'pageSectionHashes', async () => new Map())
    t.mock.method(youtubeStore, 'savePage', async (url, title, sections) => {
      savedPages.push({ url, title, sections })
    })
    let extractedOnce = false
    t.mock.method(youtubeStore, 'sectionsToExtract', async () => {
      if (extractedOnce || !savedPages.length) return []
      extractedOnce = true
      const p = savedPages[0]
      return [{ url: p.url, position: 0, title: p.title, heading: p.sections[0].heading, text: p.sections[0].text, text_hash: 'h1' }]
    })
    t.mock.method(youtubeStore, 'saveFacts', async (url, pos, hash, facts) => {
      savedFacts.push({ url, facts })
    })
    t.mock.method(youtubeStore, 'sectionsToEmbed', async () => [])
    t.mock.method(youtubeStore, 'factsToEmbed', async () => [])

    installGemini([[{
      text: JSON.stringify([
        { kind: 'term', name: 'フェロモン渋滞', aliases: [], content: 'アリの道標フェロモンがループするとコロニー全体が同じ場所を回り続ける現象' }
      ])
    }]])

    await videoSummary.storeSummary('100', 'vidExternal9', '- [0:00] 他チャンネルの動画要約')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(savedPages.length, 0, 'external video (channel_id null) is not added to community knowledge')

    await videoSummary.storeSummary('100', 'vidOwn00001', '- [4:20] 道標フェロモンが円を描くとアリが無限ループするフェロモン渋滞を確認')
    for (let i = 0; i < 10 && !savedFacts.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(savedPages.length, 1)
    assert.equal(savedPages[0].url, 'https://www.youtube.com/watch?v=vidOwn00001')
    assert.equal(savedFacts.length, 1)
    assert.equal(savedFacts[0].facts[0].name, 'フェロモン渋滞')
  })

  test('searchWiki, relatedKnowledge, and describeServer surface YouTube video knowledge and related videos in streamer mode only', async (t) => {
    process.env.YOUTUBE_CHANNELS = 'UCTW2tw0Mhho72MojB1L48IQ'
    configureGateway()
    installEmbeddingModel()
    installLoreStore()
    installEmojiStore()
    installStreamerStyleStore()
    t.after(() => {
      require('../helpers/fakes').restoreLoreStore()
      require('../helpers/fakes').restoreEmojiStore()
      require('../helpers/fakes').restoreStreamerStyleStore()
    })

    for (const s of [wikiStore, xStore, discordStore, webStore]) {
      t.mock.method(s, 'hasSections', async () => false)
      t.mock.method(s, 'nearestFacts', async () => [])
      t.mock.method(s, 'nearestSections', async () => [])
      t.mock.method(s, 'characterFacts', async () => [])
    }

    t.mock.method(youtubeStore, 'hasSections', async () => true)
    t.mock.method(youtubeStore, 'characterFacts', async () => [
      { name: 'ボブ市長', aliases: ['ボブ'], content: '都市開発動画シリーズで毎回ダム決壊に巻き込まれる市長キャラ' }
    ])
    t.mock.method(youtubeStore, 'nearestFacts', async () => [
      {
        kind: 'term',
        name: '汚水ダム発電',
        aliases: [],
        content: 'Cities: Skylines の動画で下水を高台に溜めて水力発電し街が水没した実験',
        url: 'https://www.youtube.com/watch?v=vidDam00001',
        title: '下水で水力発電する街（YouTube 動画）',
        heading: '動画の内容',
        score: 0.89
      }
    ])
    t.mock.method(youtubeStore, 'nearestSections', async () => [
      {
        url: 'https://www.youtube.com/watch?v=vidDam00001',
        title: '下水で水力発電する街（YouTube 動画）',
        heading: '動画の内容',
        text: '- [8:10] 高台のカルデラに下水を流し込み1600MWの発電に成功するが堤防が決壊',
        score: 0.86
      }
    ])

    // 1. searchWiki works with YOUTUBE_CHANNELS alone (even when WIKI_URLS is empty).
    const wikiResult = await wikiKnowledge.searchWiki('下水で発電')
    assert.match(wikiResult, /\[用語・ネタ\] 汚水ダム発電: Cities: Skylines の動画で下水を高台に溜めて水力発電/)
    assert.match(wikiResult, /下水で水力発電する街（YouTube 動画） \/ 動画の内容（https:\/\/www\.youtube\.com\/watch\?v=vidDam00001）/)

    // 2. relatedKnowledge matches characters born in YouTube videos by name AND pulls near video facts.
    const related = await wikiKnowledge.relatedKnowledge('ボブ市長の街でやった発電って何だっけ', [1, 0, 0], { random: () => 0 })
    assert.ok(related.some(l => l.includes('[キャラクター] ボブ市長（ボブ）')))
    assert.ok(related.some(l => l.includes('[用語・ネタ] 汚水ダム発電')))

    // 3. describeServer surfaces both コミュニティの知識 and 依頼に関係しそうな動画・配信 (with timestamp links) in streamer mode,
    //    and omits both when streamerPersona is false.
    const { embed, toBase64 } = require('../../src/bot/utils/embeddings')
    const [damVec, otherVec] = await embed(['ボブ市長の下水ダム水力発電の話', 'ホラー実況の話'])
    installYouTubeStore({
      100: {
        channel: { channel_id: 'UCTW2tw0Mhho72MojB1L48IQ', title: 'のばまんゲームス', synced_at: new Date('2026-11-15T00:00:00Z') },
        videos: [
          {
            video_id: 'vidDam00001',
            title: '下水で水力発電する街',
            description: '下水ダム実験',
            summary: '- [8:10] 高台に下水を溜めて1600MW発電達成、直後に決壊',
            live_status: 'none',
            published_at: new Date('2026-11-05T09:00:00Z'),
            url: 'https://www.youtube.com/watch?v=vidDam00001'
          },
          {
            video_id: 'vidCook0002',
            title: '無関係な動画',
            description: '別の話',
            live_status: 'none',
            published_at: new Date('2026-11-01T09:00:00Z'),
            url: 'https://www.youtube.com/watch?v=vidCook0002'
          }
        ]
      }
    })
    installEmbeddingStore({
      videos: {
        100: {
          vidDam00001: toBase64(damVec),
          vidCook0002: toBase64(otherVec)
        }
      }
    })

    const guild = createGuild({ id: '100', channels: [{ id: '201', name: '雑談', readers: ['1', 'BOT'] }] })
    const member = createMember({ id: '1' })
    installBot({ guilds: [guild] })

    const streamerProfile = await describeServer(guild, member, '201', {
      query: 'ボブ市長の下水ダム水力発電の話',
      streamerPersona: true
    })
    assert.match(streamerProfile, /### コミュニティの知識（wiki・YouTube 動画/)
    assert.match(streamerProfile, /汚水ダム発電/)
    assert.match(streamerProfile, /ボブ市長/)
    assert.match(streamerProfile, /### 依頼に関係しそうな動画・配信（YouTube より）/)
    assert.match(streamerProfile, /下水で水力発電する街[\s\S]*\[8:10\]\(https:\/\/www\.youtube\.com\/watch\?v=vidDam00001&t=490s\)/)
    assert.doesNotMatch(streamerProfile, /無関係な動画/)

    const pureBotProfile = await describeServer(guild, member, '201', {
      query: 'ボブ市長の下水ダム水力発電の話',
      streamerPersona: false
    })
    assert.doesNotMatch(pureBotProfile, /コミュニティの知識|依頼に関係しそうな動画・配信|汚水ダム発電|下水で水力発電する街/)
  })
})
