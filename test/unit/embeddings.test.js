const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installEmbeddingModel, installEmbeddingStore } = require('../helpers/fakes')
const { embed, embedQuery, blend, similarity, quantize, toVectorLiteral, toBase64, fromBase64, DIMENSIONS } = require('../../src/bot/utils/embeddings')
const indexer = require('../../src/bot/modules/embeddingIndexer')
const semanticSearch = require('../../src/bot/modules/semanticSearch')

describe('embeddings', () => {
  beforeEach(() => configureGateway())

  test('normalizes and quantizes, so similarity is the cosine', () => {
    const a = quantize([3, 4])
    assert.deepEqual([...a], [76, 102])
    assert.ok(Math.abs(similarity(a, a) - 1) < 0.01)
    assert.ok(Math.abs(similarity(quantize([1, 0]), quantize([0, 1]))) < 0.01)
    assert.deepEqual([...fromBase64(toBase64(Int8Array.from([-127, 0, 5])))], [-127, 0, 5])
    assert.equal(toVectorLiteral(Int8Array.from([127, -127, 0])), '[1.0000,-1.0000,0.0000]', 'as pgvector reads it')
  })

  test('embeds through the gateway in batches of 100, as documents or as a query', async () => {
    const batches = installEmbeddingModel()
    const vectors = await embed(Array.from({ length: 150 }, (_, i) => `text ${i}`))
    assert.equal(vectors.length, 150)
    assert.equal(vectors[0].length, DIMENSIONS)
    assert.deepEqual(batches.map(b => b.requests.length), [100, 50])
    assert.deepEqual(Object.keys(batches[0].requests[0]).sort(), ['content', 'model', 'outputDimensionality', 'taskType'])
    assert.equal(batches[0].requests[0].model, 'models/gemini-embedding-001')
    assert.equal(batches[0].requests[0].taskType, 'RETRIEVAL_DOCUMENT')
    await embedQuery('怖い話')
    assert.equal(batches[2].requests[0].taskType, 'RETRIEVAL_QUERY')
  })

  test('gemini-embedding-2 gets the purpose as a text prefix, since it takes no taskType', async () => {
    const batches = installEmbeddingModel()
    process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2'
    try {
      await embed(['ホラー実況'])
      await embedQuery('怖いゲーム')
      assert.deepEqual(batches[0].requests[0], { model: 'models/gemini-embedding-2', content: { parts: [{ text: 'title: none | text: ホラー実況' }] }, outputDimensionality: DIMENSIONS })
      assert.equal(batches[1].requests[0].content.parts[0].text, 'task: search result | query: 怖いゲーム')
      assert.equal('taskType' in batches[1].requests[0], false)
    } finally {
      delete process.env.GEMINI_EMBEDDING_MODEL
    }
  })
})

describe('embeddingIndexer', () => {
  beforeEach(() => configureGateway())

  test('embeds videos whose text changed, and leaves the rest', async () => {
    installEmbeddingModel()
    const saved = installEmbeddingStore()
    const same = { video_id: 'v1', title: 'ホラーゲーム実況', description: '', summary: null }
    same.text_hash = indexer.hashOf(`gemini-embedding-001\n${indexer.videoText(same)}`)
    require('../../src/db/interfaces/postgres/embeddings').videosForEmbedding = async () => [
      same,
      { video_id: 'v2', title: 'マイクラ建築', description: '城', summary: '大きな城を建てる', text_hash: 'old' }
    ]
    assert.equal(await indexer.indexVideos(), 1)
    assert.deepEqual(saved.videos.map(v => [v.videoID, v.model]), [['v2', 'gemini-embedding-001']])

    // Another model: every video is embedded again, since vectors of different models don't compare.
    process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-002'
    try {
      assert.equal(await indexer.indexVideos(), 2)
      assert.deepEqual(saved.videos.slice(1).map(v => [v.videoID, v.model]), [['v1', 'gemini-embedding-002'], ['v2', 'gemini-embedding-002']])
    } finally {
      delete process.env.GEMINI_EMBEDDING_MODEL
    }
    assert.equal(indexer.videoText({ title: 'a', description: 'b', summary: 'c' }), 'a\nb\n内容の要約: c')
  })

  test('embeds pending messages as written, and only marks empty, noise or channel-less ones', async () => {
    const batches = installEmbeddingModel()
    const saved = installEmbeddingStore({
      pending: [
        { id: '1', guild_id: '100', channel_id: '201', ts: new Date(), content: '怖い話して\\_ね' },
        { id: '2', guild_id: '100', channel_id: '201', ts: new Date(), content: 'None' },
        { id: '3', guild_id: null, channel_id: null, ts: new Date(), content: '昔のメッセージ' },
        { id: '4', guild_id: '100', channel_id: '201', ts: new Date(), content: 'wwwwww' },
        { id: '5', guild_id: '100', channel_id: '201', ts: new Date(), content: 'https://youtu.be/abcdefghijk' }
      ]
    })
    assert.equal(await indexer.indexMessages(), 1)
    assert.equal(batches[0].requests[0].content.parts[0].text, '怖い話して_ね')
    assert.deepEqual(saved.messages.map(m => m.id), ['1'])
    assert.deepEqual(saved.handled, ['1', '2', '3', '4', '5'])
    assert.equal(saved.resetFor, 'gemini-embedding-001', 'messages embedded by another model are sent back first')
    assert.equal(saved.messages[0].model, 'gemini-embedding-001')
  })

  test('embeds messages only when MESSAGE_EMBEDDINGS=true', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    installEmbeddingModel()
    const saved = installEmbeddingStore({ pending: [{ id: '1', guild_id: '100', channel_id: '201', ts: new Date(), content: '歌枠のアーカイブ' }] })
    delete process.env.MESSAGE_EMBEDDINGS
    await indexer.runOnce()
    assert.equal(saved.messages.length, 0)
    process.env.MESSAGE_EMBEDDINGS = 'true'
    try {
      await indexer.runOnce()
      assert.equal(saved.messages.length, 1)
    } finally {
      delete process.env.MESSAGE_EMBEDDINGS
    }
  })

  test('drops the embeddings of noise embedded before it was left out, once, batch by batch', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    installEmbeddingModel()
    const embedding = 'AAAA'
    const saved = installEmbeddingStore({
      messages: [
        { message_id: '01', content: '明日の配信何時から？', embedding },
        { message_id: '02', content: 'wwwwww', embedding },
        { message_id: '03', content: 'https://youtu.be/abcdefghijk', embedding },
        { message_id: '04', content: '草', embedding: null },
        { message_id: '05', content: 'None', embedding },
        { message_id: '06', content: '<@308674858781245440>', embedding }
      ]
    })
    Object.assign(indexer.cleanse, { after: '', cleansed: false, dropped: 0 })
    assert.equal(await indexer.cleanseMessages(), 4)
    assert.deepEqual(saved.dropped, ['02', '03', '05', '06'], 'only noise (also no text, or only a mention), and only what has an embedding')
    assert.equal(await indexer.cleanseMessages(), 0)
    assert.equal(indexer.cleanse.cleansed, true)
    assert.equal(await indexer.cleanseMessages(), 0, 'done once')
    assert.equal(saved.dropped.length, 4)
  })

  test('past messages go to the Batch API, one batch at a time; recent ones are embedded right away', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const saved = installEmbeddingStore({
      pending: [
        { id: 'new', guild_id: '100', channel_id: '201', ts: new Date(), content: '今日の配信たのしみ' },
        { id: 'p1', guild_id: '100', channel_id: '201', ts: old, content: '去年のホラー配信こわかった' },
        { id: 'p2', guild_id: '100', channel_id: '201', ts: old, content: 'wwwww' },
        { id: 'p3', guild_id: '100', channel_id: '201', ts: old, content: 'マイクラのコラボまたやって' }
      ]
    })
    const requests = []
    let state = 'BATCH_STATE_RUNNING'
    const sync = installEmbeddingModel()
    const embedOne = global.fetch
    global.fetch = async (url, init = {}) => {
      if (String(url).endsWith(':batchEmbedContents')) return embedOne(url, init)
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null })
      if (String(url).endsWith(':asyncBatchEmbedContent')) return { ok: true, json: async () => ({ name: 'batches/e1', metadata: { state: 'BATCH_STATE_PENDING' } }) }
      // The batch, streamed in small pieces: its state, and its results once it is done.
      if (String(url).endsWith('/batches/e1')) {
        const values = new Array(DIMENSIONS).fill(0)
        values[0] = 1
        const done = state === 'BATCH_STATE_SUCCEEDED'
        const text = JSON.stringify({ name: 'batches/e1', metadata: { '@type': 'x', state }, ...(done ? { done, response: { inlinedResponses: { inlinedResponses: [{ metadata: { key: 'p3' }, response: { embedding: { values } } }, { metadata: { key: 'p1' }, error: { message: 'x' } }] } } } : {}) }, null, 2)
        const bytes = new TextEncoder().encode(text)
        const body = []
        for (let i = 0; i < bytes.length; i += 97) body.push(bytes.slice(i, i + 97))
        return { ok: true, body }
      }
      throw new Error(`unexpected ${url}`)
    }
    process.env.MESSAGE_EMBEDDINGS = 'true'
    try {
      assert.equal(await indexer.indexMessages(), 1)
      assert.deepEqual(saved.messages.map(m => m.id), ['new'], 'the recent one right away')
      assert.equal(sync.length, 1)
      const [sent] = requests
      assert.match(sent.url, /models\/gemini-embedding-001:asyncBatchEmbedContent$/)
      const inline = sent.body.batch.inputConfig.requests.requests
      assert.deepEqual(inline.map(r => r.metadata.key), ['p1', 'p3'])
      assert.deepEqual(Object.keys(inline[0].request).sort(), ['content', 'model', 'outputDimensionality', 'taskType'])
      assert.equal(inline[0].request.taskType, 'RETRIEVAL_DOCUMENT')
      assert.ok(saved.handled.includes('p2'), 'noise is only marked as handled')
      assert.deepEqual(saved.batches.map(b => b.message_ids), [['p1', 'p3']])

      await indexer.indexMessages()
      assert.equal(requests.filter(r => r.url.endsWith(':asyncBatchEmbedContent')).length, 1, 'no second batch while one runs')

      state = 'BATCH_STATE_SUCCEEDED'
      await indexer.indexMessages()
      assert.ok(saved.messages.some(m => m.id === 'p3' && m.embedding.length === DIMENSIONS))
      assert.ok(!saved.messages.some(m => m.id === 'p1'), 'one Gemini could not embed has no vector...')
      assert.ok(saved.handled.includes('p1'), '...but is handled, not sent again and again')
      assert.equal(saved.batches.length, 0)
    } finally {
      delete process.env.MESSAGE_EMBEDDINGS
    }
  })

  test('past messages go in batches of EMBEDDING_BATCH_SIZE, up to EMBEDDING_BATCH_CONCURRENCY at a time', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const saved = installEmbeddingStore({
      pending: ['ホラー配信こわかった', 'マイクラのコラボまたやって', '歌枠よかった', '雑談配信いつ？', 'ゲーム大会たのしみ']
        .map((content, i) => ({ id: `p${i}`, guild_id: '100', channel_id: '201', ts: old, content }))
    })
    installEmbeddingModel()
    let n = 0
    const submitted = []
    global.fetch = async (url, init = {}) => {
      if (String(url).endsWith(':asyncBatchEmbedContent')) {
        submitted.push(JSON.parse(init.body).batch.inputConfig.requests.requests.map(r => r.metadata.key))
        return { ok: true, json: async () => ({ name: `batches/b${++n}`, metadata: { state: 'BATCH_STATE_PENDING' } }) }
      }
      if (/\/batches\/b\d$/.test(String(url))) {
        return { ok: true, body: [new TextEncoder().encode(JSON.stringify({ name: 'x', metadata: { state: 'BATCH_STATE_RUNNING' } }))] }
      }
      throw new Error(`unexpected ${url}`)
    }
    process.env.MESSAGE_EMBEDDINGS = 'true'
    process.env.EMBEDDING_BATCH_SIZE = '2'
    process.env.EMBEDDING_BATCH_CONCURRENCY = '2'
    try {
      await indexer.indexMessages()
      assert.deepEqual(submitted, [['p0', 'p1'], ['p2', 'p3']], 'two batches of two')
      await indexer.indexMessages()
      assert.equal(submitted.length, 2, 'no third while two run')
      process.env.EMBEDDING_BATCH_CONCURRENCY = '3'
      await indexer.indexMessages()
      assert.deepEqual(submitted[2], ['p4'], 'the rest once there is room')
      assert.equal(saved.batches.length, 3)
    } finally {
      delete process.env.MESSAGE_EMBEDDINGS
      delete process.env.EMBEDDING_BATCH_SIZE
      delete process.env.EMBEDDING_BATCH_CONCURRENCY
    }
  })

  test('a batch that cannot be looked at is noted and tried again, without holding up recent messages; one too old or gone is given up on', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    const warned = t.mock.method(global.logger, 'warn', () => {})
    const saved = installEmbeddingStore({ pending: [{ id: 'new', guild_id: '100', channel_id: '201', ts: new Date(), content: '今日の配信たのしみ' }] })
    saved.batches.push({ name: 'batches/old', model: 'gemini-embedding-001', message_ids: ['p1'], created_at: new Date() })
    saved.batched.add('p1')
    installEmbeddingModel()
    const embedOne = global.fetch
    const asked = []
    let answer = { ok: false, status: 500, text: async () => 'internal' }
    global.fetch = async (url, init = {}) => {
      if (String(url).endsWith(':batchEmbedContents')) return embedOne(url, init)
      asked.push({ url: String(url), method: init.method })
      if (String(url).endsWith('/batches/old')) return answer
      if (String(url).endsWith('/batches/old:cancel')) return { ok: true, json: async () => ({}) }
      if (String(url).endsWith(':asyncBatchEmbedContent')) return { ok: true, json: async () => ({ name: 'batches/next' }) }
      throw new Error(`unexpected ${url}`)
    }
    process.env.MESSAGE_EMBEDDINGS = 'true'
    try {
      assert.equal(await indexer.indexMessages(), 1, 'the recent one is embedded all the same')
      assert.equal(saved.batches[0].last_error, 'Gemini GET batches/old failed: HTTP 500 internal')
      assert.match(warned.mock.calls[0].arguments[0], /Could not look at batch batches\/old/)

      // Still running, and older than Gemini keeps a batch: asked to stop, its messages sent again.
      answer = { ok: true, body: [new TextEncoder().encode(JSON.stringify({ name: 'batches/old', metadata: { state: 'BATCH_STATE_RUNNING' } }))] }
      await indexer.batchPastMessages(new Date(), Date.now() + 51 * 3600000)
      assert.ok(asked.some(a => a.url.endsWith('/batches/old:cancel') && a.method === 'POST'))
      assert.equal(saved.batches.some(b => b.name === 'batches/old'), false)
      assert.equal(saved.batched.has('p1'), false, 'p1 is pending again')

      // Gone at Gemini: given up on at once.
      saved.batches.push({ name: 'batches/old', model: 'gemini-embedding-001', message_ids: [], created_at: new Date() })
      answer = { ok: false, status: 404, text: async () => 'not found' }
      await indexer.batchPastMessages(new Date())
      assert.equal(saved.batches.some(b => b.name === 'batches/old'), false)
    } finally {
      delete process.env.MESSAGE_EMBEDDINGS
    }
  })

  test('EMBEDDING_BATCH_AFTER_HOURS=0 embeds every message right away', async () => {
    process.env.EMBEDDING_BATCH_AFTER_HOURS = '0'
    try {
      installEmbeddingModel()
      const saved = installEmbeddingStore({ pending: [{ id: 'p1', guild_id: '100', channel_id: '201', ts: new Date(0), content: '昔のホラー配信の話' }] })
      assert.equal(await indexer.indexMessages(), 1)
      assert.equal(saved.batches.length, 0)
    } finally {
      delete process.env.EMBEDDING_BATCH_AFTER_HOURS
    }
  })

  test('a failure is logged and tried again next time', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    installEmbeddingStore()
    require('../../src/db/interfaces/postgres/embeddings').videosForEmbedding = async () => { throw new Error('db down') }
    await indexer.runOnce()
    assert.match(warned.mock.calls[0].arguments[0], /Indexing failed, trying again next time: db down/)
  })
})

describe('semanticSearch', () => {
  beforeEach(() => configureGateway())

  test('finds messages by meaning, with keyword matches first', async () => {
    installEmbeddingModel()
    const [horror, minecraft] = await embed(['ホラー', 'マイクラ'])
    installEmbeddingStore({
      messages: [
        { message_id: 'a', guild_id: '100', channel_id: '201', ts: new Date(1), author_id: '2', content: 'マイクラで城を作った', embedding: toBase64(minecraft) },
        { message_id: 'b', guild_id: '100', channel_id: '201', ts: new Date(2), author_id: '2', content: 'ホラーゲームやろう', embedding: toBase64(horror) },
        { message_id: 'c', guild_id: '100', channel_id: '201', ts: new Date(3), author_id: '3', content: '怖いのは苦手', embedding: toBase64(horror) },
        { message_id: 'd', guild_id: '100', channel_id: '202', ts: new Date(4), author_id: '3', content: '怖い話', embedding: toBase64(horror) }
      ]
    })
    const found = await semanticSearch.searchMessages('100', ['201'], '怖い', { limit: 2 })
    assert.deepEqual(found.map(m => m.id), ['c', 'b'], 'the keyword match first; channel 202 is not searched')
    assert.equal(found[0].content, '怖いのは苦手')
  })

  test('ranks videos by meaning, or says there is nothing to rank by', async () => {
    installEmbeddingModel()
    const [horror, minecraft] = await embed(['ホラー', 'マイクラ'])
    installEmbeddingStore({ videos: { 100: { v1: toBase64(minecraft), v2: toBase64(horror) } } })
    const videos = [{ video_id: 'v1', title: 'マイクラ建築' }, { video_id: 'v2', title: '深夜の実況' }]
    assert.deepEqual((await semanticSearch.rankVideos('100', videos, 'こわいゲーム')).map(v => v.video_id), ['v2', 'v1'])
    assert.equal(await semanticSearch.rankVideos('999', videos, 'x'), null)
  })
})

describe('blend', () => {
  test('one unit vector for several, each counting its weight', () => {
    const a = quantize([1, 0, 0])
    const b = quantize([0, 1, 0])
    const mixed = blend([a, b], [0.6, 0.4])
    assert.ok(Math.abs(similarity(mixed, mixed) - 1) < 0.02, 'unit length')
    assert.ok(similarity(mixed, a) > similarity(mixed, b))
    assert.ok(similarity(mixed, b) > 0)
  })
})
