const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { Readable } = require('stream')
const websub = require('../../src/miscellaneous/websub')

const UC = 'UC' + 'h'.repeat(22)
const SECRET = 'hub-secret'

// A request as http.Server hands it over, and a response that records what was sent.
function request (method, path, { body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  Object.assign(req, { method, url: path, headers })
  return req
}
function response () {
  const res = { status: null, body: null, headersSent: false }
  res.writeHead = status => {
    res.status = status
    res.headersSent = true
    return res
  }
  res.end = body => { res.body = body ?? null }
  return res
}
const sign = (body, secret = SECRET) => `sha1=${crypto.createHmac('sha1', secret).update(body).digest('hex')}`

describe('websub', () => {
  let saved
  const store = {
    isKnownChannel: async id => id === UC,
    saveWebsub: async (id, expires) => saved.push([id, expires])
  }
  beforeEach(() => {
    saved = []
    process.env.YOUTUBE_WEBSUB_SECRET = SECRET
    process.env.YOUTUBE_WEBSUB_URL = 'https://robo.up.railway.app/'
  })
  afterEach(() => {
    delete process.env.YOUTUBE_WEBSUB_SECRET
    delete process.env.YOUTUBE_WEBSUB_URL
  })

  test('confirms a subscription for a channel it follows, and records when it runs out', async () => {
    const res = response()
    const topic = encodeURIComponent(websub.topicOf(UC))
    await websub.handle(request('GET', `/youtube/websub?hub.mode=subscribe&hub.topic=${topic}&hub.challenge=abc&hub.lease_seconds=3600`), res, { store })
    assert.deepEqual([res.status, res.body], [200, 'abc'])
    assert.equal(saved[0][0], UC)
    assert.ok(Math.abs(saved[0][1] - Date.now() - 3600 * 1000) < 5000)
  })

  test('refuses to confirm a channel it does not follow', async () => {
    const res = response()
    const topic = encodeURIComponent(websub.topicOf('UC' + 'x'.repeat(22)))
    await websub.handle(request('GET', `/youtube/websub?hub.mode=subscribe&hub.topic=${topic}&hub.challenge=abc`), res, { store })
    assert.equal(res.status, 404)
  })

  test('passes on a signed notification, and silently drops an unsigned or forged one', async () => {
    const body = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>${UC}</yt:channelId></entry></feed>`
    const relayed = []
    const relay = n => relayed.push(n)
    for (const signature of [sign(body), undefined, sign(body, 'wrong')]) {
      const res = response()
      await websub.handle(request('POST', '/youtube/websub', { body, headers: signature ? { 'x-hub-signature': signature } : {} }), res, { store, relay })
      assert.equal(res.status, 204)
    }
    assert.deepEqual(relayed, [{ channelID: UC, videoID: 'abcdefghijk' }])
  })

  test('answers 404 to any other path', async () => {
    const res = response()
    await websub.handle(request('GET', '/'), res, { store })
    assert.equal(res.status, 404)
  })

  test('subscribes channels that have no subscription or one running out, with the secret', async () => {
    const posts = []
    const fetchImpl = async (url, init) => {
      posts.push({ url, params: Object.fromEntries(new URLSearchParams(init.body)) })
      return { ok: false, status: 202 }
    }
    await websub.renew({ websubDue: async () => [UC] }, fetchImpl)
    assert.equal(posts[0].url, 'https://pubsubhubbub.appspot.com/subscribe')
    assert.deepEqual(posts[0].params, {
      'hub.callback': 'https://robo.up.railway.app/youtube/websub',
      'hub.topic': websub.topicOf(UC),
      'hub.verify': 'async',
      'hub.mode': 'subscribe',
      'hub.secret': SECRET,
      'hub.lease_seconds': String(5 * 24 * 60 * 60)
    })
  })

  test('does not start without a public URL and a secret', () => {
    delete process.env.YOUTUBE_WEBSUB_URL
    assert.equal(websub.start(), null)
  })
})
