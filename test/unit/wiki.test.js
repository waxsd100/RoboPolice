// Reading the community wiki: pages split at their headings, the crawl, and searching it.
const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installEmbeddingModel } = require('../helpers/fakes')
const { parseWikiPage } = require('../../src/bot/utils/wikiPage')
const store = require('../../src/db/interfaces/postgres/wiki')
const wiki = require('../../src/bot/modules/wikiKnowledge')

const ROOT = 'https://example.memo.wiki/'
const page = (title, body, extra = '') => `<html><head><title>${title} - テストwiki</title></head><body>
<div id="page-body-inner"><div class="user-area">${body}</div></div>
<div id="comment-box"><div class="text">コメント欄の書き込み</div></div>
<div id="page-footer">footer</div>
<div class="user-area"><h2>Menu</h2><a href="/d/MenuBar1">menu</a></div>${extra}</body></html>`

afterEach(() => { delete process.env.WIKI_URLS })

describe('parseWikiPage', () => {
  test("splits the body at its headings, keeps each part's images, and finds the wiki's pages", () => {
    const html = page('キャラクター', `
      <h3 id="content_1">個性的なキャラクター <a title="部分編集" href="https://seesaawiki.jp/x/e/edit">✎</a></h3>
      <p>いろいろいます。</p>
      <h4 id="content_1_1">よつろん <a title="部分編集" href="https://seesaawiki.jp/x/e/edit?id=2">✎</a></h4>
      <p>四葉の&amp;笑顔。</p><img src="https://image01.seesaawiki.jp/n/a.png"><img src="https://static.seesaawiki.jp/icon.gif">
      <h4 id="content_1_2">クリーム</h4><p>謎の生物。<br>被害者。</p>`,
    '<a href="/d/%a4%ce%a4%d0">名言</a> <a href="https://other.example/d/x">外</a> <a href="/t/external-link/x">x</a> <a href="/d/page?foo=1#top">q</a>')
    const parsed = parseWikiPage(html, `${ROOT}d/chars`)
    assert.equal(parsed.title, 'キャラクター')
    assert.deepEqual(parsed.sections, [
      { heading: '個性的なキャラクター', text: 'いろいろいます。', images: [] },
      { heading: 'よつろん', text: '四葉の&笑顔。', images: ['https://image01.seesaawiki.jp/n/a.png'] },
      { heading: 'クリーム', text: '謎の生物。\n被害者。', images: [] }
    ])
    assert.deepEqual(parsed.links.sort(), [`${ROOT}d/%a4%ce%a4%d0`, `${ROOT}d/page`])
  })

  test('a long part is split into pieces under the same heading', () => {
    const long = Array.from({ length: 60 }, (_, i) => `<p>${'あ'.repeat(40)}${i}</p>`).join('')
    const sections = parseWikiPage(page('長い', `<h3 id="content_1">長い話</h3>${long}`), `${ROOT}d/long`).sections
    assert.ok(sections.length > 1)
    assert.ok(sections.every(s => s.heading === '長い話' && s.text.length <= 1500))
  })
})

describe('crawl', () => {
  test('reads every page it links to, once, within the wiki', async (t) => {
    const saved = []
    t.mock.method(store, 'savePage', async (url, title, sections) => saved.push([url, title, sections.length]))
    const site = {
      [ROOT]: page('トップ', '<p>入口</p><a href="/d/a">A</a><a href="/d/b">B</a>'),
      [`${ROOT}d/a`]: page('A', '<p>a</p><a href="/d/b">B</a><a href="/">top</a>'),
      [`${ROOT}d/b`]: page('B', '<p>b</p>')
    }
    const fetched = []
    const read = await wiki.crawl(new URL(ROOT), { delay: 0, fetchPage: async url => { fetched.push(url); if (!site[url]) throw new Error('404'); return { html: site[url] } } })
    assert.deepEqual(read, [ROOT, `${ROOT}d/a`, `${ROOT}d/b`])
    assert.deepEqual(fetched, [ROOT, `${ROOT}d/a`, `${ROOT}d/b`, `${ROOT}d/`].slice(0, fetched.length))
    assert.deepEqual(saved.map(s => s[1]), ['トップ', 'A', 'B'])
  })
})

describe('searchWiki', () => {
  test('returns the closest knowledge, then the closest parts with their page and URL', async (t) => {
    process.env.WIKI_URLS = ROOT
    configureGateway()
    installEmbeddingModel()
    t.mock.method(store, 'hasSections', async () => true)
    t.mock.method(store, 'nearestFacts', async () => [{ kind: 'quote', name: '〇〇だぜ', aliases: [], content: '配信の締めに言う', url: `${ROOT}d/q`, title: '名言集', heading: '締め' }])
    const nearest = t.mock.method(store, 'nearestSections', async () => [{ url: `${ROOT}d/q`, title: '名言集', heading: '締め', text: '有名な台詞。', score: 0.9 }])
    const xStore = require('../../src/db/interfaces/postgres/xKnowledge')
    t.mock.method(xStore, 'hasSections', async () => false)
    const text = await wiki.searchWiki('名言')
    assert.equal(text, [
      'wiki で「名言」に意味が近いもの（近い順）:', '', '知識:', '- [名言・台詞] 〇〇だぜ: 配信の締めに言う（名言集 / 締め）',
      '', '本文:', `- 名言集 / 締め（${ROOT}d/q）`, '有名な台詞。'
    ].join('\n'))
    assert.equal(nearest.mock.calls[0].arguments[1], 'gemini-embedding-001')
  })

  test('the wiki\'s and the X posts\' tables are searched together, the closest first', async (t) => {
    process.env.WIKI_URLS = ROOT
    configureGateway()
    installEmbeddingModel()
    const xStore = require('../../src/db/interfaces/postgres/xKnowledge')
    for (const tables of [store, xStore]) t.mock.method(tables, 'hasSections', async () => true)
    t.mock.method(store, 'nearestFacts', async () => [{ kind: 'term', name: 'wiki の用語', aliases: [], content: 'a', title: 'wiki', heading: 'h', score: 0.5 }])
    t.mock.method(xStore, 'nearestFacts', async () => [{ kind: 'term', name: 'X の用語', aliases: [], content: 'b', title: '@a のポスト', heading: 'h', score: 0.8 }])
    t.mock.method(store, 'nearestSections', async () => [])
    t.mock.method(xStore, 'nearestSections', async () => [])
    const text = await wiki.searchWiki('用語', { facts: 1 })
    assert.match(text, /X の用語/)
    assert.doesNotMatch(text, /wiki の用語/)
  })

  test('says so when there is no wiki, or it is not read yet', async (t) => {
    assert.equal(await wiki.searchWiki('x'), 'wiki は設定されていません')
    process.env.WIKI_URLS = ROOT
    t.mock.method(store, 'hasSections', async () => false)
    t.mock.method(require('../../src/db/interfaces/postgres/xKnowledge'), 'hasSections', async () => false)
    assert.match(await wiki.searchWiki('x'), /まだ読み込まれていません/)
  })

  test('the characters for describing emojis, with a hash that changes with them', async (t) => {
    process.env.WIKI_URLS = ROOT
    t.mock.method(store, 'characterFacts', async () => [])
    t.mock.method(store, 'characters', async () => [{ heading: 'よつろん', text: '四葉の\n笑顔。' }])
    const { text, hash } = await wiki.characterContext()
    assert.equal(text, '- よつろん: 四葉の 笑顔。')
    assert.match(hash, /^[0-9a-f]{16}$/)
    delete process.env.WIKI_URLS
    assert.deepEqual(await wiki.characterContext(), { text: '', hash: null })
  })

  test('the characters come from the knowledge, with other names and looks, when there is any', async (t) => {
    process.env.WIKI_URLS = ROOT
    t.mock.method(store, 'characterFacts', async () => [{ name: 'よつろん', aliases: ['yotsuron'], content: '頭に大きな四葉。白々しい笑顔' }])
    assert.equal((await wiki.characterContext()).text, '- よつろん（yotsuron）: 頭に大きな四葉。白々しい笑顔')
  })
})

describe('extractFacts', () => {
  test('asks Gemini for characters, quotes and terms as JSON, and keeps only well-formed ones', async () => {
    configureGateway()
    const { installGemini } = require('../helpers/fakes')
    const requests = installGemini([[{
      text: JSON.stringify([
        { kind: 'character', name: 'よつろん', aliases: ['yotsuron', ''], content: '頭に四葉の笑顔のキャラクター' },
        { kind: 'quote', name: 'ご安心を', content: '' },
        { kind: 'other', name: 'x', content: 'y' },
        { kind: 'term', name: 'のば描き', content: 'ファンアートのこと' }
      ])
    }]])
    const facts = await wiki.extractFacts({ title: 'のばまんのキャラクター', heading: 'よつろん', text: 'のばまんのアイコンのキャラクター。' })
    assert.deepEqual(facts, [
      { kind: 'character', name: 'よつろん', aliases: ['yotsuron'], content: '頭に四葉の笑顔のキャラクター' },
      { kind: 'term', name: 'のば描き', aliases: [], content: 'ファンアートのこと' }
    ])
    const { generationConfig, contents } = requests[0].body
    assert.equal(generationConfig.responseMimeType, 'application/json')
    assert.deepEqual(generationConfig.responseSchema.items.properties.kind.enum, ['character', 'quote', 'term'])
    assert.match(contents[0].parts[0].text, /ページ: のばまんのキャラクター\n見出し: よつろん\n本文:\nのばまんのアイコンのキャラクター。/)
  })

  test('a part that fails is left for next time; the others go on', async (t) => {
    const saved = []
    t.mock.method(store, 'sectionsToExtract', async () => [{ url: 'u', position: 0, title: 't', heading: 'a', text: 'x', text_hash: 'h0' }, { url: 'u', position: 1, title: 't', heading: 'b', text: 'y', text_hash: 'h1' }])
    t.mock.method(store, 'saveFacts', async (url, position, hash, facts) => saved.push([position, hash, facts.length]))
    t.mock.method(require('../../src/db/interfaces/postgres/xKnowledge'), 'sectionsToExtract', async () => [])
    configureGateway()
    const { installGemini } = require('../helpers/fakes')
    installGemini([new Error('boom'), [{ text: '[]' }]])
    const logged = []
    assert.equal(await wiki.extractPending({ log: m => logged.push(m) }), 1)
    assert.deepEqual(saved, [[1, 'h1', 0]])
    assert.match(logged[0], /Could not take knowledge out of t \/ a/)
  })
})
