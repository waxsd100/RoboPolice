const dns = require('dns')
const net = require('net')
const http = require('http')
const https = require('https')

const FETCH_TIMEOUT_MS = 10000
const MAX_REDIRECTS = 3
const MAX_BODY_BYTES = 2 * 1024 * 1024
// Per page, after HTML is reduced to text. Keeps the Gemini prompt small and cheap.
const MAX_TEXT_CHARS = 20000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// The URL comes from a Discord message, so without this anyone allowed to trigger the bot could make
// it request internal addresses (Redis, Postgres, cloud metadata). Checked inside `lookup` so the
// address that is validated is the address that is connected to: no DNS rebinding window.
const blockedAddresses = new net.BlockList()
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedAddresses.addSubnet(subnet, prefix, 'ipv4')
for (const [subnet, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blockedAddresses.addSubnet(subnet, prefix, 'ipv6')
}

function isBlockedAddress (address, family) {
  if (family === 6 || family === 'IPv6') {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return blockedAddresses.check(mapped[1], 'ipv4')
    return blockedAddresses.check(address, 'ipv6')
  }
  return blockedAddresses.check(address, 'ipv4')
}

function safeLookup (isBlocked) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      const allowed = addresses.filter(a => !isBlocked(a.address, a.family))
      if (allowed.length === 0) return callback(new Error(`${hostname} はプライベートアドレスを指しているため取得できません`))
      if (options.all) return callback(null, allowed)
      callback(null, allowed[0].address, allowed[0].family)
    })
  }
}

// What a request is for: the Accept header, the content types it takes, and how much it reads.
// A page that is too long is cut (its start is still useful); an image that is too big is refused.
const KINDS = {
  page: {
    accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
    types: /^text\/(html|plain)|application\/xhtml\+xml/i,
    maxBytes: MAX_BODY_BYTES,
    truncate: true
  },
  image: {
    accept: 'image/*',
    types: /^image\/(jpeg|png|webp|gif|avif)/i,
    maxBytes: MAX_IMAGE_BYTES,
    truncate: false
  }
}

function request (url, isBlocked, kind) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const req = client.get(url, {
      lookup: safeLookup(isBlocked),
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'RoboPolice (+https://github.com/waxsd100/RoboPolice)', Accept: kind.accept }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve({ redirect: new URL(res.headers.location, url) })
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const contentType = res.headers['content-type'] || ''
      if (!kind.types.test(contentType)) {
        res.resume()
        return reject(new Error(`対応していない形式です (${contentType || '不明'})`))
      }
      const chunks = []
      let size = 0
      const done = () => resolve({ body: Buffer.concat(chunks), contentType })
      res.on('data', chunk => {
        size += chunk.length
        if (size > kind.maxBytes) {
          // Settle before destroying, since destroying emits an error.
          if (kind.truncate) {
            chunks.push(chunk.subarray(0, chunk.length - (size - kind.maxBytes)))
            done()
          } else {
            reject(new Error(`ファイルが大きすぎます（${Math.floor(kind.maxBytes / 1024 / 1024)}MB まで）`))
          }
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on('end', done)
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('タイムアウトしました')))
    req.on('error', reject)
  })
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities (text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

// Event pages usually carry the facts that matter (date, venue) in <title>, meta tags and
// schema.org JSON-LD, so those are kept separately ahead of the body text.
function htmlToText (html) {
  const parts = []
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title) parts.push(`タイトル: ${decodeEntities(title[1]).trim()}`)
  for (const meta of html.matchAll(/<meta\s[^>]*>/gi)) {
    const key = meta[0].match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]
    const content = meta[0].match(/content\s*=\s*["']([^"']*)["']/i)?.[1]
    if (key && content && /^(description|og:title|og:description|og:image$|twitter:image$|event:|og:start_time|og:end_time)/i.test(key)) {
      parts.push(`${key}: ${decodeEntities(content).trim()}`)
    }
  }
  for (const ld of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(`JSON-LD: ${ld[1].trim()}`)
  }
  const body = decodeEntities(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  parts.push(`本文:\n${body}`)
  return parts.join('\n')
}

// Follows redirects itself so every hop goes through the same address checks.
async function fetchChecked (rawUrl, kind, isBlocked) {
  let url = new URL(rawUrl)
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http/https 以外の URL は取得できません')
    // An IP literal is connected to directly without calling `lookup`, so check it here.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const family = net.isIP(host)
    if (family !== 0 && isBlocked(host, family)) throw new Error(`${host} はプライベートアドレスのため取得できません`)
    const res = await request(url, isBlocked, kind)
    if (res.redirect) {
      url = res.redirect
      continue
    }
    return { url: url.toString(), ...res }
  }
  throw new Error('リダイレクトが多すぎます')
}

// `isBlocked` exists so tests can reach a local server; production callers never pass it.
async function fetchPageText (rawUrl, { isBlocked = isBlockedAddress } = {}) {
  const res = await fetchChecked(rawUrl, KINDS.page, isBlocked)
  const body = res.body.toString('utf8')
  const text = /html/i.test(res.contentType) ? htmlToText(body) : body.trim()
  return { url: res.url, text: text.slice(0, MAX_TEXT_CHARS) }
}

async function fetchImage (rawUrl, { isBlocked = isBlockedAddress } = {}) {
  const res = await fetchChecked(rawUrl, KINDS.image, isBlocked)
  return { url: res.url, buffer: res.body, contentType: res.contentType }
}

module.exports = { fetchPageText, fetchImage, htmlToText, isBlockedAddress }
