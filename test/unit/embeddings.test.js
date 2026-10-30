const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installEmbeddingModel, installEmbeddingStore } = require('../helpers/fakes')
const { embed, embedQuery, similarity, quantize, toBase64, fromBase64, DIMENSIONS } = require('../../src/bot/utils/embeddings')
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

  test('embeds pending messages as written, and only marks empty or channel-less ones', async () => {
    const batches = installEmbeddingModel()
    const saved = installEmbeddingStore({
      pending: [
        { id: '1', guild_id: '100', channel_id: '201', ts: new Date(), content: '怖い話して\\_ね' },
        { id: '2', guild_id: '100', channel_id: '201', ts: new Date(), content: 'None' },
        { id: '3', guild_id: null, channel_id: null, ts: new Date(), content: '昔のメッセージ' }
      ]
    })
    assert.equal(await indexer.indexMessages(), 1)
    assert.equal(batches[0].requests[0].content.parts[0].text, '怖い話して_ね')
    assert.deepEqual(saved.messages.map(m => m.id), ['1'])
    assert.deepEqual(saved.handled, ['1', '2', '3'])
    assert.equal(saved.resetFor, 'gemini-embedding-001', 'messages embedded by another model are sent back first')
    assert.equal(saved.messages[0].model, 'gemini-embedding-001')
  })

  test('embeds messages only when MESSAGE_EMBEDDINGS=true', async (t) => {
    t.mock.method(global.logger, 'info', () => {})
    installEmbeddingModel()
    const saved = installEmbeddingStore({ pending: [{ id: '1', guild_id: '100', channel_id: '201', ts: new Date(), content: '歌' }] })
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

  test('topK keeps only the best', () => {
    const best = semanticSearch.topK(2)
    for (const score of [0.1, 0.9, 0.5, 0.7]) best.offer({ score })
    assert.deepEqual(best.items.map(i => i.score), [0.9, 0.7])
  })
})
