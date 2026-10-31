// The streamer's X posts as knowledge: read through FxTwitter, stored, and written as monthly pages.
const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
require('../helpers/fakes')
const store = require('../../src/db/interfaces/postgres/social')
const wikiStore = require('../../src/db/interfaces/postgres/wiki')
const x = require('../../src/bot/modules/twitterKnowledge')

afterEach(() => { delete process.env.TWITTER_ACCOUNTS })

const tweet = (id, text, extra = {}) => ({
  id,
  text,
  url: `https://x.com/nobamangames/status/${id}`,
  created_timestamp: Date.parse('2026-10-30T03:00:00Z') / 1000 - Number(id),
  author: { screen_name: 'nobamangames' },
  ...extra
})

describe('readTimeline', () => {
  test('keeps the account\'s own posts (replies too), leaves reposts out, and pages back', async () => {
    const pages = [
      { results: [tweet('9', '最新'), tweet('8', '他人の', { author: { screen_name: 'someone' }, reposted_by: { screen_name: 'nobamangames' } }), tweet('7', '返信', { replying_to: { screen_name: 'friend' } })], cursor: { bottom: 'c1' } },
      { results: [tweet('6', '古い', { media: { photos: [{ url: 'https://pbs.twimg.com/a.jpg' }] } })], cursor: { bottom: 'c2' } },
      { results: [], cursor: {} }
    ]
    const urls = []
    const posts = await x.readTimeline('nobamangames', { delay: 0, fetchJSON: async url => { urls.push(url); return pages[urls.length - 1] } })
    assert.deepEqual(posts.map(p => [p.id, p.text, p.replyTo]), [['9', '最新', null], ['7', '返信', 'friend'], ['6', '古い', null]])
    assert.deepEqual(posts[2].mediaUrls, ['https://pbs.twimg.com/a.jpg'])
    assert.deepEqual(urls, [
      'https://api.fxtwitter.com/2/profile/nobamangames/statuses',
      'https://api.fxtwitter.com/2/profile/nobamangames/statuses?cursor=c1',
      'https://api.fxtwitter.com/2/profile/nobamangames/statuses?cursor=c2'
    ])
  })

  test('stops at the first page whose posts are all stored, and at maxPages', async () => {
    const fetched = []
    const fetchJSON = async url => { fetched.push(url); return { results: [tweet(String(10 - fetched.length), 'x')], cursor: { bottom: `c${fetched.length}` } } }
    assert.deepEqual((await x.readTimeline('nobamangames', { known: new Set(['8']), delay: 0, fetchJSON })).map(p => p.id), ['9'])
    assert.equal(fetched.length, 2)
    fetched.length = 0
    await x.readTimeline('nobamangames', { maxPages: 3, delay: 0, fetchJSON })
    assert.equal(fetched.length, 3)
  })
})

describe('monthSections', () => {
  test('one line per post with its day and URL, in parts of at most 1500 characters', () => {
    const posts = Array.from({ length: 40 }, (_, i) => ({ url: `https://x.com/a/status/${i}`, text: `ポスト${i} ${'あ'.repeat(60)}`, created_at: new Date(Date.UTC(2026, 9, 1 + (i % 28), 3)), reply_to: i === 0 ? 'friend' : null }))
    const page = x.monthSections('nobamangames', '2026-10', posts)
    assert.equal(page.title, '@nobamangames のポスト（2026年10月）')
    assert.ok(page.sections.length > 1)
    assert.ok(page.sections.every(s => s.text.length <= 1500 && /^2026年10月 \d+$/.test(s.heading)))
    assert.match(page.sections[0].text.split('\n')[0], /^\[2026-10-01\] @friend への返信: ポスト0 あ+ https:\/\/x\.com\/a\/status\/0$/)
  })
})

describe('refresh', () => {
  test('stores new posts and writes the months they are in as knowledge pages', async (t) => {
    process.env.TWITTER_ACCOUNTS = '@nobamangames'
    t.mock.method(store, 'knownIds', async () => new Set(['1']))
    t.mock.method(store, 'savePosts', async posts => posts)
    t.mock.method(store, 'postsOfMonth', async () => [{ url: 'https://x.com/nobamangames/status/2', text: '告知', created_at: new Date('2026-10-30T03:00:00Z'), reply_to: null }])
    const pages = []
    t.mock.method(wikiStore, 'savePage', async (url, title, sections) => pages.push([url, title, sections.length]))
    t.mock.method(global.logger, 'info', () => {})
    const added = await x.refresh({ fetchJSON: async () => ({ results: [tweet('2', '告知'), tweet('1', '古い')], cursor: {} }) })
    assert.equal(added, 1)
    assert.deepEqual(pages, [['https://x.com/nobamangames#2026-10', '@nobamangames のポスト（2026年10月）', 1]])
  })

  test('does nothing without TWITTER_ACCOUNTS', async () => {
    assert.equal(await x.refresh(), null)
    assert.deepEqual(x.accounts(), [])
  })
})

describe('getJSON', () => {
  test('tries a failed request again, a few times at most', async () => {
    let calls = 0
    const ok = await x.getJSON('u', { wait: async () => {}, fetchImpl: async () => ++calls < 3 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ fine: true }) } })
    assert.deepEqual(ok, { fine: true })
    calls = 0
    await assert.rejects(x.getJSON('u', { wait: async () => {}, fetchImpl: async () => { calls++; return { ok: false, status: 503 } } }), /HTTP 503/)
    assert.equal(calls, 3)
  })
})
