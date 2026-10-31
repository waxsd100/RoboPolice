// Describing a server's emojis from their name and image, and offering those that suit a request.
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, createGuild, createMember } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const store = require('../../src/db/interfaces/postgres/emojis')
const emojiDescriber = require('../../src/bot/modules/emojiDescriber')
const { describeServer } = require('../../src/bot/modules/eventTools')

const GATEWAY = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID', 'GEMINI_API_KEY', 'EMOJI_DESCRIPTIONS']
afterEach(() => { for (const name of GATEWAY) delete process.env[name] })

// Gemini for both: a description per emoji, and an embedding that is 1 on the axis of a topic word.
function installModels (descriptions) {
  const seen = { described: [], embedded: [] }
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (String(url).endsWith(':batchEmbedContents')) {
      seen.embedded.push(...body.requests.map(r => r.content.parts[0].text))
      return {
        ok: true,
        json: async () => ({
          embeddings: body.requests.map(r => {
            const text = r.content.parts[0].text
            const values = new Array(r.outputDimensionality).fill(0)
            values[/笑|草/.test(text) ? 0 : /泣|悲/.test(text) ? 1 : 2] = 1
            return { values }
          })
        })
      }
    }
    const [prompt, image] = body.contents[0].parts
    const name = prompt.text.match(/「:(\w+):」/)[1]
    seen.described.push({ name, image: image.inlineData.mimeType })
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: descriptions[name] }] } }] }) }
  }
  return seen
}

describe('syncGuild', () => {
  let rows
  beforeEach((t) => {
    configureGateway()
    rows = new Map()
    t.mock.method(urlFetcher, 'fetchImage', async url => ({ buffer: Buffer.from(url), contentType: 'image/png' }))
    t.mock.method(store, 'syncEmojis', async (guildID, emojis) => {
      for (const e of emojis) rows.set(e.id, { ...rows.get(e.id), emoji_id: e.id, name: e.name })
      for (const id of rows.keys()) if (!emojis.some(e => e.id === id)) rows.delete(id)
    })
    t.mock.method(store, 'emojisToDescribe', async () => [...rows.values()].filter(r => !r.description || r.described_name !== r.name))
    t.mock.method(store, 'saveDescription', async (id, name, description) => Object.assign(rows.get(id), { description, described_name: name, embedding: null }))
    t.mock.method(store, 'emojisToEmbed', async () => [...rows.values()].filter(r => r.description && !r.embedding))
    t.mock.method(store, 'saveEmbedding', async (id, embedding, model) => Object.assign(rows.get(id), { embedding, model }))
    t.mock.method(global.logger, 'info', () => {})
  })

  test('describes each usable emoji from its name and image, then embeds name and description', async () => {
    const seen = installModels({ kusa: '草が生えている。笑ったときに使う', naki: '泣いている顔。悲しいときに使う' })
    const guild = { id: '100', emojis: [{ id: '1', name: 'kusa' }, { id: '2', name: 'naki', animated: true }, { id: '3', name: 'staff', roles: ['9'] }] }
    assert.deepEqual(await emojiDescriber.syncGuild(guild), { described: 2, embedded: 2 })
    assert.deepEqual(seen.described, [{ name: 'kusa', image: 'image/png' }, { name: 'naki', image: 'image/png' }])
    assert.deepEqual(seen.embedded, [':kusa: 草が生えている。笑ったときに使う', ':naki: 泣いている顔。悲しいときに使う'])
    assert.equal(rows.get('1').model, 'gemini-embedding-001')
    assert.ok(!rows.has('3'), 'an emoji limited to some roles is not used')

    // Nothing new: nothing is asked again. A renamed emoji is described again.
    assert.deepEqual(await emojiDescriber.syncGuild(guild), { described: 0, embedded: 0 })
    installModels({ www: '草が生えている。笑ったときに使う' })
    guild.emojis[0].name = 'www'
    assert.deepEqual(await emojiDescriber.syncGuild(guild), { described: 1, embedded: 1 })
  })

  test('an emoji that cannot be described is left for the next run', async (t) => {
    t.mock.method(global.logger, 'warn', () => {})
    installModels({ kusa: '' })
    assert.deepEqual(await emojiDescriber.syncGuild({ id: '100', emojis: [{ id: '1', name: 'kusa' }] }), { described: 0, embedded: 0 })
    assert.equal(rows.get('1').description, undefined)
  })
})

describe('the emojis in the server profile', () => {
  const guild = () => {
    const g = createGuild({ channels: [{ id: '1', name: 'general', readers: ['1'] }] })
    g.emojis = [{ id: '11', name: 'naki' }, { id: '12', name: 'kusa' }, { id: '13', name: 'newone' }]
    return g
  }

  test('with descriptions, one per line, those closest to the request first', async (t) => {
    configureGateway()
    installModels({})
    t.mock.method(store, 'descriptions', async () => ({ 11: '泣いている顔。悲しいときに使う', 12: '草。笑ったときに使う' }))
    const nearest = t.mock.method(store, 'nearestEmojis', async () => ['12', '11'])
    const text = await describeServer(guild(), createMember({ id: '1' }), '1', { query: '面白すぎて草' })
    assert.match(text, /### サーバー絵文字（返事で使うときは、この書き方のまま書く）。話に合いそうな順:\n- <:kusa:12> 草。笑ったときに使う\n- <:naki:11> 泣いている顔。悲しいときに使う\n- <:newone:13>\n/)
    assert.equal(nearest.mock.calls[0].arguments[0], '100')
  })

  test('without descriptions (or turned off), just the codes', async (t) => {
    const descriptions = t.mock.method(store, 'descriptions', async () => ({}))
    configureGateway()
    assert.match(await describeServer(guild(), createMember({ id: '1' }), '1', { query: 'x' }), /### サーバー絵文字（返事で使うときは、この書き方のまま書く）\n<:naki:11> <:kusa:12> <:newone:13>/)
    process.env.EMOJI_DESCRIPTIONS = 'false'
    await describeServer(guild(), createMember({ id: '1' }), '1')
    assert.equal(descriptions.mock.callCount(), 1, 'turned off: the store is not read')
  })
})
