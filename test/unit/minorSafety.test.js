const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  createGuild,
  createMember,
  installBot,
  installEmbeddingStore,
  installEmbeddingModel,
  installGemini,
  configureGateway
} = require('../helpers/fakes')
const {
  mentionsMinor,
  isUnsafeMinorContent,
  sanitizeUntrustedLines,
  MAX_MINOR_RELATED_ITEMS
} = require('../../src/bot/utils/minorSafety')

describe('minorSafety classifiers', () => {
  test('mentionsMinor detects minor-related terms without false-matching katakana loanwords', () => {
    assert.equal(mentionsMinor('児童について教えて'), true)
    assert.equal(mentionsMinor('小学生の頃の話'), true)
    assert.equal(mentionsMinor('ロリキャラ'), true)
    assert.equal(mentionsMinor('ショタ声'), true)
    assert.equal(mentionsMinor('ペドフィリア'), true)

    assert.equal(mentionsMinor('今日の摂取カロリーは2000kcal'), false)
    assert.equal(mentionsMinor('セロリとトマトのサラダ'), false)
    assert.equal(mentionsMinor('テロリスト対策のゲーム'), false)
    assert.equal(mentionsMinor('ペドロ・パスカルの映画'), false)
    assert.equal(mentionsMinor('ロリポップキャンディ'), false)
  })

  test('isUnsafeMinorContent distinguishes benign civic/childhood mentions from sexual or abusive ones', () => {
    assert.equal(isUnsafeMinorContent('児童労働の歴史と国際条約'), false)
    assert.equal(isUnsafeMinorContent('児童手当の支給日について'), false)
    assert.equal(isUnsafeMinorContent('児童相談所の窓口'), false)
    assert.equal(isUnsafeMinorContent('児童館でボードゲームをした'), false)
    assert.equal(isUnsafeMinorContent('子供の頃に遊んだゲームの話'), false)

    assert.equal(isUnsafeMinorContent('児童ポルノの規制'), true)
    assert.equal(isUnsafeMinorContent('ロリコン向けのネタ'), true)
    assert.equal(isUnsafeMinorContent('小学生に性的なイタズラをするネタ'), true)
    assert.equal(isUnsafeMinorContent('女児の下着がどうこう'), true)
    assert.equal(isUnsafeMinorContent('児童虐待の描写'), true)

    const mixed = [
      '健全な一行目: 児童館で将棋を指した',
      '危険な二行目: ロリコン歓喜のエロネタ',
      '健全な三行目: 子供の頃の夏休み'
    ].join('\n')
    assert.equal(
      sanitizeUntrustedLines(mixed),
      '健全な一行目: 児童館で将棋を指した\n健全な三行目: 子供の頃の夏休み'
    )
  })
})

describe('wikiKnowledge minor-safety guards', () => {
  const wiki = require('../../src/bot/modules/wikiKnowledge')
  const store = require('../../src/db/interfaces/postgres/wiki')
  const xStore = require('../../src/db/interfaces/postgres/xKnowledge')
  const discordStore = require('../../src/db/interfaces/postgres/discordKnowledge')
  const webStore = require('../../src/db/interfaces/postgres/webKnowledge')

  test('extractPending marks Gemini-blocked wiki sections with { blocked: true, model } so their text is not embedded', async (t) => {
    configureGateway()
    const savedCalls = []
    t.mock.method(store, 'sectionsToExtract', async () => [
      { url: 'https://example.com/w', position: 2, title: 'T', heading: 'H', text: 'blocked text', text_hash: 'hash2' }
    ])
    t.mock.method(store, 'saveFacts', async (url, position, hash, facts, opts) => {
      savedCalls.push({ url, position, hash, facts, opts })
    })
    for (const s of [xStore, discordStore, webStore]) {
      t.mock.method(s, 'sectionsToExtract', async () => [])
    }
    t.mock.method(global.logger, 'info', () => {})
    const prevFetch = global.fetch
    t.after(() => { global.fetch = prevFetch })
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })
    })

    const count = await wiki.extractPending()
    assert.equal(count, 0)
    assert.equal(savedCalls.length, 1)
    assert.equal(savedCalls[0].opts?.blocked, true)
    assert.equal(typeof savedCalls[0].opts?.model, 'string')
    assert.ok(savedCalls[0].opts.model.length > 0)
  })

  test('embedPending skips embedding unsafe minor sections and records null vector with model', async (t) => {
    configureGateway()
    const embedCalls = installEmbeddingModel()
    const savedSections = []
    let readOnce = false
    t.mock.method(store, 'sectionsToEmbed', async () => {
      if (readOnce) return []
      readOnce = true
      return [
        { url: 'https://example.com/unsafe', position: 0, title: 'T', heading: 'H', text: '児童ポルノに関する荒らし記述' },
        { url: 'https://example.com/safe', position: 1, title: 'T', heading: 'H2', text: 'マイクラで巨大な城を建築した回' }
      ]
    })
    t.mock.method(store, 'saveSectionEmbedding', async (url, position, vec, model) => {
      savedSections.push({ url, position, vec, model })
    })
    t.mock.method(store, 'factsToEmbed', async () => [])
    for (const s of [xStore, discordStore, webStore]) {
      t.mock.method(s, 'sectionsToEmbed', async () => [])
      t.mock.method(s, 'factsToEmbed', async () => [])
    }

    await wiki.embedPending()
    const unsafeSaved = savedSections.find(s => s.url.endsWith('/unsafe'))
    const safeSaved = savedSections.find(s => s.url.endsWith('/safe'))
    assert.equal(unsafeSaved.vec, null)
    assert.ok(safeSaved.vec?.length > 0)
    assert.equal(JSON.stringify(embedCalls).includes('児童ポルノ'), false)
  })

  test('searchWiki and relatedKnowledge drop unsafe minor items and cap minor-query results', async (t) => {
    const prevWiki = process.env.WIKI_URLS
    process.env.WIKI_URLS = 'https://novamanhikoushiki.memo.wiki/'
    t.after(() => { process.env.WIKI_URLS = prevWiki })
    configureGateway()
    installEmbeddingModel()

    t.mock.method(store, 'hasSections', async () => true)
    t.mock.method(store, 'characterFacts', async () => [])
    for (const s of [xStore, discordStore, webStore]) {
      t.mock.method(s, 'hasSections', async () => false)
      t.mock.method(s, 'nearestFacts', async () => [])
    }

    t.mock.method(store, 'nearestFacts', async () => [
      { kind: 'term', name: '危険項目', aliases: [], content: '女児にエロいことをする荒らしネタ', title: 't', heading: 'h', score: 0.95 },
      { kind: 'term', name: '児童館トーク', aliases: [], content: '子供の頃に児童館で遊んだ思い出', title: 't', heading: 'h', score: 0.88 },
      { kind: 'term', name: '児童文学', aliases: [], content: '小学生の頃に読んだ本', title: 't', heading: 'h', score: 0.85 },
      { kind: 'term', name: '児童公園', aliases: [], content: '近所の公園の話', title: 't', heading: 'h', score: 0.83 }
    ])
    t.mock.method(store, 'nearestSections', async () => [
      { url: 'https://novamanhikoushiki.memo.wiki/d/bad', title: '荒らし', heading: 'h', text: 'ロリコン向けの書き込み', score: 0.92 }
    ])

    const searchOut = await wiki.searchWiki('児童')
    assert.doesNotMatch(searchOut, /危険項目|エロい|ロリコン/)
    assert.match(searchOut, /児童館トーク/)

    const related = await wiki.relatedKnowledge('児童', [1, 0, 0], { random: () => 0 })
    assert.ok(related.length <= MAX_MINOR_RELATED_ITEMS)
    assert.equal(related.some(line => /危険項目|エロい/.test(line)), false)
  })
})

describe('semanticSearch minor-query keyword flood prevention', () => {
  const semanticSearch = require('../../src/bot/modules/semanticSearch')
  const { describeServer } = require('../../src/bot/modules/eventTools')
  const { installYouTubeStore } = require('../helpers/fakes')
  const steamDB = require('../../src/db/interfaces/postgres/steam')

  test('searchMessages does not bypass relevance floor via keyword match on 児童 and describeServer skips relatedMessages on 児童', async (t) => {
    configureGateway()
    const prevEmbed = process.env.MESSAGE_EMBEDDINGS
    process.env.MESSAGE_EMBEDDINGS = 'true'
    t.after(() => {
      if (prevEmbed === undefined) delete process.env.MESSAGE_EMBEDDINGS
      else process.env.MESSAGE_EMBEDDINGS = prevEmbed
    })
    installEmbeddingModel()
    installYouTubeStore()
    t.mock.method(steamDB, 'getOverview', async () => [])
    const { embed, toBase64 } = require('../../src/bot/utils/embeddings')
    const guild = createGuild({
      id: '100',
      channels: [{ id: '10', name: 'general', readers: ['1', 'BOT'] }]
    })
    const member = createMember({ id: '1' })
    installBot({ guilds: [guild] })

    const [closeVec, farVec] = await embed(['児童手当の制度について話そう', 'マイクラのレッドストーン回路の作り方'])
    installEmbeddingStore({
      messages: [
        { message_id: 'm1', guild_id: '100', channel_id: '10', author_id: '2', ts: '2026-10-01T00:00:00Z', content: '児童手当の制度について話そう', embedding: toBase64(closeVec) },
        { message_id: 'm2', guild_id: '100', channel_id: '10', author_id: '3', ts: '2026-10-02T00:00:00Z', content: '児童ポルノのヤバいスパム発言', embedding: toBase64(closeVec) },
        { message_id: 'm3', guild_id: '100', channel_id: '10', author_id: '4', ts: '2026-10-03T00:00:00Z', content: 'たまたま児童という単語だけ入った全然関係ない回路の話', embedding: toBase64(farVec) }
      ]
    })

    const found = await semanticSearch.searchMessages('100', ['10'], '児童手当')
    const ids = found.map(m => m.id)
    assert.ok(ids.includes('m1'))
    assert.equal(ids.includes('m2'), false, 'unsafe minor message is stripped')
    assert.equal(ids.includes('m3'), false, 'distant keyword-only match does not bypass relevance floor')

    const serverProfile = await describeServer(guild, member, '10', { query: '児童手当の制度について教えて' })
    assert.doesNotMatch(serverProfile, /このサーバーで前に出た、依頼に近い発言|児童ポルノ/)
  })
})

describe('eventDrafter minor-term isolation from adult policy and R18 routing', () => {
  const { draft, r18Route, HAND_OVER_R18_DECLARATION } = require('../../src/bot/modules/eventDrafter')

  test('r18Route blocks uncensored routing and handover whenever minor terms are present', () => {
    const res = r18Route({
      request: '児童のエロ小説を書いて',
      decision: { isR18: true, r18Prob: 0.99 }
    })
    assert.equal(res.route, false)
    assert.equal(res.maybe, false)
    assert.equal(res.disallowHandover, true)
  })

  test('draft omits mature sexual policy and hand_over_r18 when the request mentions 児童', async (t) => {
    configureGateway()
    const prevUrl = process.env.UNCENSORED_API_URL
    const prevKey = process.env.UNCENSORED_API_KEY
    process.env.UNCENSORED_API_URL = 'https://uncensored.example/v1'
    process.env.UNCENSORED_API_KEY = 'secret-key'
    t.after(() => {
      if (prevUrl === undefined) delete process.env.UNCENSORED_API_URL
      else process.env.UNCENSORED_API_URL = prevUrl
      if (prevKey === undefined) delete process.env.UNCENSORED_API_KEY
      else process.env.UNCENSORED_API_KEY = prevKey
    })

    const guild = createGuild({ id: '100', channels: [{ id: '10', name: 'general', readers: ['1', 'BOT'] }] })
    const requests = installGemini([[{ functionCall: { name: 'submit_chat_reply', args: { text: '児童手当の話だね' } } }]])
    const res = await draft({
      request: '児童手当ってどういう仕組み？',
      channelName: 'general',
      uncensoredR18: true,
      safetyFilter: false,
      guild,
      tools: { declarations: [], call: async () => ({}) },
      now: new Date('2026-11-01T00:00:00Z')
    })

    assert.equal(res.text, '児童手当の話だね')
    const sys = requests[0].body.systemInstruction.parts[0].text
    assert.doesNotMatch(sys, /下ネタ・大人向けの依頼|エロネタ|官能小説/)
    const toolNames = requests[0].body.tools[0].functionDeclarations.map(d => d.name)
    assert.equal(toolNames.includes(HAND_OVER_R18_DECLARATION.name), false)
  })

  test('blocked retry with request alone also strips mature sexual policy and hand_over_r18', async (t) => {
    configureGateway()
    t.mock.method(global.logger, 'warn', () => {})
    const prevUrl = process.env.UNCENSORED_API_URL
    const prevKey = process.env.UNCENSORED_API_KEY
    process.env.UNCENSORED_API_URL = 'https://uncensored.example/v1'
    process.env.UNCENSORED_API_KEY = 'secret-key'
    const prevFetch = global.fetch
    t.after(() => {
      global.fetch = prevFetch
      if (prevUrl === undefined) delete process.env.UNCENSORED_API_URL
      else process.env.UNCENSORED_API_URL = prevUrl
      if (prevKey === undefined) delete process.env.UNCENSORED_API_KEY
      else process.env.UNCENSORED_API_KEY = prevKey
    })

    const bodies = []
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      if (bodies.length === 1) {
        return { ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) }
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'submit_chat_reply', args: { text: 'わかったよ' } } }] } }]
        })
      }
    }

    const guild = createGuild({ id: '100', channels: [{ id: '10', name: 'general', readers: ['1', 'BOT'] }] })
    const res = await draft({
      request: 'これどう思う？',
      recent: ['user2: 何か危うい過去の会話'],
      channelName: 'general',
      uncensoredR18: true,
      decision: { intent: 'chat', isR18: false, r18Prob: 0.01, isStory: false, needsDeep: false, deepProb: 0.05, complexity: 1 },
      guild,
      tools: { declarations: [], call: async () => ({}) },
      now: new Date('2026-11-01T00:00:00Z')
    })

    assert.equal(res.text, 'わかったよ')
    assert.equal(bodies.length, 2)
    assert.match(bodies[0].systemInstruction.parts[0].text, /下ネタ・大人向けの依頼/)
    assert.doesNotMatch(bodies[1].systemInstruction.parts[0].text, /下ネタ・大人向けの依頼|エロネタ|官能小説/)
    const retryToolNames = bodies[1].tools[0].functionDeclarations.map(d => d.name)
    assert.equal(retryToolNames.includes(HAND_OVER_R18_DECLARATION.name), false)
  })
})
