const { test, describe, after, before } = require('node:test')
const assert = require('node:assert/strict')
const { fetchPageText, htmlToText, isBlockedAddress } = require('../../src/bot/utils/urlFetcher')
const { startServer } = require('../helpers/fakes')

describe('isBlockedAddress', () => {
  for (const [address, family] of [
    ['127.0.0.1', 4], ['10.1.2.3', 4], ['172.16.0.1', 4], ['192.168.1.1', 4], ['169.254.169.254', 4],
    ['100.64.0.1', 4], ['0.0.0.0', 4], ['224.0.0.1', 4],
    ['::1', 6], ['::', 6], ['fd00::1', 6], ['fe80::1', 6], ['::ffff:127.0.0.1', 6], ['::ffff:10.0.0.1', 6]
  ]) {
    test(`blocks ${address}`, () => assert.equal(isBlockedAddress(address, family), true))
  }
  for (const [address, family] of [['8.8.8.8', 4], ['1.1.1.1', 4], ['2001:4860:4860::8888', 6], ['::ffff:8.8.8.8', 6]]) {
    test(`allows ${address}`, () => assert.equal(isBlockedAddress(address, family), false))
  }
  test('accepts the IPv6 family as dns.lookup reports it', () => {
    assert.equal(isBlockedAddress('::1', 'IPv6'), true)
  })
})

describe('htmlToText', () => {
  const html = `<html><head>
    <title>技術 &amp; 交流会</title>
    <meta property="og:description" content="11/3 19時〜">
    <meta name="viewport" content="width=device-width">
    <script type="application/ld+json">{"@type":"Event","startDate":"2026-11-03T19:00+09:00"}</script>
    <style>body { color: red }</style>
  </head><body><h1>本文</h1><p>場所:&#x6771;&#20140;</p><script>evil()</script><noscript>no</noscript></body></html>`
  const text = htmlToText(html)

  test('keeps the title with entities decoded', () => assert.match(text, /^タイトル: 技術 & 交流会/))
  test('keeps event-relevant meta tags only', () => {
    assert.match(text, /og:description: 11\/3 19時〜/)
    assert.doesNotMatch(text, /viewport/)
  })
  test('keeps JSON-LD verbatim', () => assert.match(text, /JSON-LD: \{"@type":"Event","startDate":"2026-11-03T19:00\+09:00"\}/))
  test('decodes numeric entities in the body', () => assert.match(text, /場所:東京/))
  test('drops scripts, styles and noscript', () => {
    assert.doesNotMatch(text, /evil|color: red|no$/m)
  })
  test('puts block elements on their own lines', () => assert.match(text, /本文\n場所:東京/))
})

describe('fetchPageText', () => {
  // The test server listens on 127.0.0.1, which production refuses; allow exactly that address.
  const allowLoopback = (address, family) => address !== '127.0.0.1' && isBlockedAddress(address, family)
  let server
  before(async () => {
    server = await startServer((req, res) => {
      const routes = {
        '/page': () => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>イベント</title><p>本文</p>') },
        '/plain': () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('  plain text  ') },
        '/image': () => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('x') },
        '/missing': () => { res.writeHead(404); res.end() },
        '/redirect': () => { res.writeHead(302, { Location: '/page' }); res.end() },
        '/loop': () => { res.writeHead(302, { Location: '/loop' }); res.end() },
        '/to-private': () => { res.writeHead(302, { Location: 'http://10.0.0.1/' }); res.end() },
        '/huge': () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('a'.repeat(3 * 1024 * 1024)) }
      }
      ;(routes[req.url] || routes['/missing'])()
    })
  })
  after(() => server.close())

  test('refuses non-http schemes', async () => {
    await assert.rejects(fetchPageText('file:///etc/passwd'), /http\/https 以外/)
    await assert.rejects(fetchPageText('ftp://example.com/'), /http\/https 以外/)
  })

  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://0x7f000001/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/']) {
    test(`refuses the IP literal in ${url}`, async () => {
      await assert.rejects(fetchPageText(url), /プライベートアドレス/)
    })
  }

  test('refuses a hostname that resolves to loopback', async () => {
    await assert.rejects(fetchPageText('http://localhost/'), /プライベートアドレス/)
  })

  test('reads an HTML page as text', async () => {
    const page = await fetchPageText(`${server.url}/page`, { isBlocked: allowLoopback })
    assert.equal(page.url, `${server.url}/page`)
    assert.match(page.text, /タイトル: イベント/)
    assert.match(page.text, /本文/)
  })

  test('returns plain text trimmed', async () => {
    const page = await fetchPageText(`${server.url}/plain`, { isBlocked: allowLoopback })
    assert.equal(page.text, 'plain text')
  })

  test('follows a redirect and reports the final URL', async () => {
    const page = await fetchPageText(`${server.url}/redirect`, { isBlocked: allowLoopback })
    assert.equal(page.url, `${server.url}/page`)
  })

  test('gives up after too many redirects', async () => {
    await assert.rejects(fetchPageText(`${server.url}/loop`, { isBlocked: allowLoopback }), /リダイレクトが多すぎます/)
  })

  test('refuses a redirect to a private address', async () => {
    await assert.rejects(fetchPageText(`${server.url}/to-private`, { isBlocked: allowLoopback }), /プライベートアドレス/)
  })

  test('refuses content that is not text', async () => {
    await assert.rejects(fetchPageText(`${server.url}/image`, { isBlocked: allowLoopback }), /対応していない形式/)
  })

  test('reports HTTP errors', async () => {
    await assert.rejects(fetchPageText(`${server.url}/missing`, { isBlocked: allowLoopback }), /HTTP 404/)
  })

  test('caps the returned text', async () => {
    const page = await fetchPageText(`${server.url}/huge`, { isBlocked: allowLoopback })
    assert.equal(page.text.length, 20000)
  })
})
