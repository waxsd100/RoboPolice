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
  test('returns the closest parts with their page and URL', async (t) => {
    process.env.WIKI_URLS = ROOT
    configureGateway()
    installEmbeddingModel()
    t.mock.method(store, 'hasSections', async () => true)
    const nearest = t.mock.method(store, 'nearestSections', async () => [{ url: `${ROOT}d/q`, title: '名言集', heading: '「〇〇」', text: '有名な台詞。', score: 0.9 }])
    const text = await wiki.searchWiki('名言')
    assert.equal(text, `wiki で「名言」に意味が近い記述（近い順）:\n- 名言集 / 「〇〇」（${ROOT}d/q）\n有名な台詞。`)
    assert.equal(nearest.mock.calls[0].arguments[1], 'gemini-embedding-001')
  })

  test('says so when there is no wiki, or it is not read yet', async (t) => {
    assert.equal(await wiki.searchWiki('x'), 'wiki は設定されていません')
    process.env.WIKI_URLS = ROOT
    t.mock.method(store, 'hasSections', async () => false)
    assert.match(await wiki.searchWiki('x'), /まだ読み込まれていません/)
  })

  test('the characters for describing emojis, with a hash that changes with them', async (t) => {
    process.env.WIKI_URLS = ROOT
    t.mock.method(store, 'characters', async () => [{ heading: 'よつろん', text: '四葉の\n笑顔。' }])
    const { text, hash } = await wiki.characterContext()
    assert.equal(text, '- よつろん: 四葉の 笑顔。')
    assert.match(hash, /^[0-9a-f]{16}$/)
    delete process.env.WIKI_URLS
    assert.deepEqual(await wiki.characterContext(), { text: '', hash: null })
  })
})
