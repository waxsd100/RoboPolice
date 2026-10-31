// Push notifications from YouTube (WebSub, formerly PubSubHubbub), so a new stream is seen in
// seconds rather than at the next poll. Runs in the master process: it subscribes every configured
// channel at Google's hub, renews the subscriptions before they lapse, and answers the hub's
// callbacks over HTTP, passing each notification to the workers (src/bot/modules/liveWatcher.js).
//
// Needs a public HTTPS address for the service (YOUTUBE_WEBSUB_URL, e.g. a Railway domain) and a
// secret the hub signs notifications with (YOUTUBE_WEBSUB_SECRET). Without both, nothing runs and
// streams are still found by polling.
const http = require('http')
const crypto = require('crypto')
const cluster = require('cluster')

const HUB = 'https://pubsubhubbub.appspot.com/subscribe'
const PATH = '/youtube/websub'
const LEASE_SECONDS = 5 * 24 * 60 * 60
const RENEW_EVERY_MS = 60 * 60 * 1000
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000
const MAX_BODY = 256 * 1024

const topicOf = channelID => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelID}`
const channelOfTopic = topic => String(topic || '').match(/channel_id=(UC[\w-]{22})/)?.[1] || null

function enabled () {
  return !!(process.env.YOUTUBE_WEBSUB_URL && process.env.YOUTUBE_WEBSUB_SECRET && process.env.YOUTUBE_API_KEY)
}

function callbackURL () {
  return `${process.env.YOUTUBE_WEBSUB_URL.replace(/\/+$/, '')}${PATH}`
}

// The hub signs each notification with the secret given when subscribing: X-Hub-Signature: sha1=…
function validSignature (body, header, secret = process.env.YOUTUBE_WEBSUB_SECRET) {
  const [algorithm, given] = String(header || '').split('=')
  if (!['sha1', 'sha256'].includes(algorithm) || !given) return false
  const expected = crypto.createHmac(algorithm, secret).update(body).digest('hex')
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

// The channel and video a notification is about (an Atom entry), or null.
function parseNotification (xml) {
  const channelID = xml.match(/<yt:channelId>(UC[\w-]{22})<\/yt:channelId>/)?.[1]
  const videoID = xml.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1]
  return channelID ? { channelID, videoID: videoID || null } : null
}

function broadcast (message) {
  for (const worker of Object.values(cluster.workers || {})) worker.send(message)
}

// Handles one request. store: { isKnownChannel, saveWebsub }; relay(notification) passes it on.
async function handle (req, res, { store, relay = n => broadcast({ type: 'youtubePush', ...n }) }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== PATH) {
    res.writeHead(404).end()
    return
  }
  if (req.method === 'GET') {
    // The hub confirming a (un)subscription: echo the challenge only for channels we follow.
    const mode = url.searchParams.get('hub.mode')
    const channelID = channelOfTopic(url.searchParams.get('hub.topic'))
    const challenge = url.searchParams.get('hub.challenge')
    const wanted = mode === 'subscribe' ? channelID && await store.isKnownChannel(channelID) : mode === 'unsubscribe'
    if (!challenge || !wanted) {
      res.writeHead(404).end()
      return
    }
    if (mode === 'subscribe') {
      const lease = Number(url.searchParams.get('hub.lease_seconds')) || LEASE_SECONDS
      await store.saveWebsub(channelID, new Date(Date.now() + lease * 1000))
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge)
    return
  }
  if (req.method === 'POST') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) {
        res.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks)
    // A notification that isn't signed with our secret is not from the hub: ignore it, but answer
    // 2xx as the WebSub spec asks, so a forger learns nothing.
    if (validSignature(body, req.headers['x-hub-signature'])) {
      const notification = parseNotification(body.toString('utf8'))
      if (notification) relay(notification)
    }
    res.writeHead(204).end()
    return
  }
  res.writeHead(405).end()
}

// Asks the hub to (re)subscribe a channel; the hub confirms through a GET to the callback.
async function subscribe (channelID, fetchImpl = fetch) {
  const res = await fetchImpl(HUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'hub.callback': callbackURL(),
      'hub.topic': topicOf(channelID),
      'hub.verify': 'async',
      'hub.mode': 'subscribe',
      'hub.secret': process.env.YOUTUBE_WEBSUB_SECRET,
      'hub.lease_seconds': String(LEASE_SECONDS)
    }),
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok && res.status !== 202) {
    // The hub says why in the body (e.g. an unreachable callback, or a secret over 200 bytes).
    const reason = await Promise.resolve(res.text?.()).catch(() => '')
    throw new Error(`hub refused ${channelID}: HTTP ${res.status}${reason ? ` ${String(reason).replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}`)
  }
}

// Subscribes channels that have no subscription or whose subscription runs out within a day.
async function renew (store, fetchImpl) {
  for (const channelID of await store.websubDue(new Date(Date.now() + RENEW_BEFORE_MS))) {
    await subscribe(channelID, fetchImpl).catch(e => global.logger.warn(`[WEBSUB]: ${e.message}`))
  }
}

function start () {
  if (!enabled()) return null
  const store = require('../db/interfaces/postgres/youtube')
  const server = http.createServer((req, res) => {
    handle(req, res, { store }).catch(e => {
      global.logger.warn(`[WEBSUB]: ${e.message}`)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  const port = Number(process.env.PORT) || 8080
  server.listen(port, () => global.logger.startup(`[WEBSUB]: Listening for YouTube pushes on port ${port} at ${callbackURL()}`))
  renew(store).catch(e => global.logger.warn(`[WEBSUB]: ${e.message}`))
  setInterval(() => renew(store).catch(e => global.logger.warn(`[WEBSUB]: ${e.message}`)), RENEW_EVERY_MS)
  return server
}

module.exports = { start, enabled, handle, subscribe, renew, validSignature, parseNotification, topicOf, PATH }
