const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { forEachArrayItem, textChunks } = require('../../src/bot/utils/jsonItems')

describe('jsonItems', () => {
  const items = [
    { metadata: { key: 'm1' }, response: { embedding: { values: [0.1, -2e-3, 3] } } },
    { metadata: { key: 'm\\2"x' }, error: { message: 'x}{][,' } },
    { metadata: { key: 'm3' }, response: { embedding: { values: [] } } }
  ]
  const data = { name: 'batches/x', metadata: { state: 'S', note: 'a "quoted, } ] { [" string', inlinedResponses: 'not an array' }, response: { inlinedResponses: { inlinedResponses: items } } }

  test('reads the objects of the named arrays one by one, however the text is cut', async () => {
    for (const text of [JSON.stringify(data), JSON.stringify(data, null, 2)]) {
      for (const size of [1, 2, 7, 64, text.length]) {
        const chunks = []
        for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
        const got = []
        assert.equal(await forEachArrayItem(chunks, 'inlinedResponses', o => got.push(o)), 3)
        assert.deepEqual(got, items, `pieces of ${size}`)
      }
    }
  })

  test('other keys and arrays are passed over; several names can be given', async () => {
    const text = JSON.stringify({ list: [{ a: 1 }], other: { inlinedEmbedContentResponses: [{ b: 2 }] } })
    const got = []
    await forEachArrayItem([text], ['inlinedResponses', 'inlinedEmbedContentResponses'], o => got.push(o))
    assert.deepEqual(got, [{ b: 2 }])
  })

  test('a response body is read as text, a character cut between pieces included', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ inlinedResponses: [{ text: '日本語のテキスト' }] }))
    const body = []
    for (let i = 0; i < bytes.length; i += 5) body.push(bytes.slice(i, i + 5))
    const got = []
    await forEachArrayItem(textChunks({ body }), 'inlinedResponses', o => got.push(o))
    assert.deepEqual(got, [{ text: '日本語のテキスト' }])
  })
})
