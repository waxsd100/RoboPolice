// Topics looked up on the web with Google Search, as knowledge.
const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini } = require('../helpers/fakes')
const store = require('../../src/db/interfaces/postgres/webKnowledge')
const web = require('../../src/bot/modules/webKnowledge')

const NOW = new Date('2026-11-01T03:00:00Z')
afterEach(() => { process.env.KNOWLEDGE_TOPICS = ''; delete process.env.WEB_REFRESH_HOURS })

describe('webKnowledge', () => {
  test('looks each topic up with Google Search and stores it as a page with its date', async (t) => {
    configureGateway()
    process.env.KNOWLEDGE_TOPICS = 'ぽみそしる（のばまんが所属する実況者グループ）,\nトマスコ（トマトスコスコ人生）'
    t.mock.method(store, 'lastRead', async url => url.includes('トマスコ') ? new Date('2026-10-31T00:00:00Z') : null)
    const pages = []
    t.mock.method(store, 'savePage', async (url, title, sections) => pages.push({ url, title, sections }))
    const removed = t.mock.method(store, 'deletePagesExcept', async () => 0)
    t.mock.method(global.logger, 'info', () => {})
    const requests = installGemini([[{ text: '## 概要\nポッキーが主催する実況者グループ。（50文字）\n\n## メンバー\nポッキー、のばまん\n\n## 出典\nhttps://example.com/a' }]])
    assert.equal(await web.refresh({ now: NOW }), 1, 'the one looked up a day ago is not looked up again')
    assert.deepEqual(requests[0].body.tools, [{ google_search: {} }])
    assert.match(requests[0].body.contents[0].parts[0].text, /今日は 2026-11-01 です。[\s\S]*ぽみそしる（のばまんが所属する実況者グループ）[\s\S]*出典/)
    assert.equal(pages[0].url, 'topic:ぽみそしる（のばまんが所属する実況者グループ）')
    assert.equal(pages[0].title, '「ぽみそしる（のばまんが所属する実況者グループ）」について（Web 検索で調べたもの、2026-11-01 時点）')
    assert.match(pages[0].sections[0].text, /^## 概要\nポッキーが主催する実況者グループ。\n\n## メンバー/)
    assert.deepEqual(removed.mock.calls[0].arguments, ['topic:', ['topic:ぽみそしる（のばまんが所属する実況者グループ）', 'topic:トマスコ（トマトスコスコ人生）']])
  })

  test('a failure is logged and tried again next time; nothing without topics', async (t) => {
    configureGateway()
    process.env.KNOWLEDGE_TOPICS = 'ぽみそしる'
    t.mock.method(store, 'lastRead', async () => null)
    t.mock.method(store, 'deletePagesExcept', async () => 0)
    const saved = t.mock.method(store, 'savePage', async () => {})
    installGemini([new Error('boom')])
    const logged = []
    assert.equal(await web.refresh({ now: NOW, log: m => logged.push(m) }), 0)
    assert.match(logged[0], /\[WEB\]: Could not look up ぽみそしる/)
    assert.equal(saved.mock.callCount(), 0)
    process.env.KNOWLEDGE_TOPICS = ''
    assert.equal(web.enabled(), false)
    assert.equal(await web.refresh({ now: NOW }), 0)
  })

  test('a long answer is cut into parts at blank lines', () => {
    const block = 'あ'.repeat(900)
    assert.deepEqual(web.parts(`${block}\n\n${block}\n\n短い`).map(p => p.length), [900, 904])
  })
})
