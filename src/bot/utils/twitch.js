// Twitch's API (Helix), with an app access token (client credentials: TWITCH_CLIENT_ID and
// TWITCH_CLIENT_SECRET, from an application registered at dev.twitch.tv). Only public data is read:
// channels and their archives (past broadcasts).
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const API = 'https://api.twitch.tv/helix'
const TIMEOUT_MS = 15 * 1000

class TwitchError extends Error {
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

function configured () {
  return !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)
}

let token = null // { value, expiresAt }

async function accessToken ({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (token && token.expiresAt - 60 * 1000 > now) return token.value
  const body = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' })
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) })
  // The response is not logged: it holds the token.
  if (!res.ok) throw new TwitchError(`Twitch token: HTTP ${res.status} (check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET)`, res.status)
  const json = await res.json()
  token = { value: json.access_token, expiresAt: now + (Number(json.expires_in) || 3600) * 1000 }
  return token.value
}

// GET from Helix. A token Twitch no longer takes is replaced once.
async function helix (path, params, { fetchImpl = fetch } = {}) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`
  for (let tries = 0; ; tries++) {
    const res = await fetchImpl(url, {
      headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${await accessToken({ fetchImpl })}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 401 && tries === 0) {
      token = null
      continue
    }
    if (!res.ok) throw new TwitchError(`Twitch ${path}: HTTP ${res.status}`, res.status)
    return res.json()
  }
}

// The channels of these logins: [{ id, login, displayName, description }] (a login with no channel
// is left out).
async function getChannels (logins, options) {
  const params = new URLSearchParams()
  for (const login of logins) params.append('login', login)
  const json = await helix('users', params, options)
  return (json.data || []).map(u => ({ id: u.id, login: u.login, displayName: u.display_name, description: u.description }))
}

// The channel's archives, newest first, up to `max`: { videos: [{ id, title, description, url,
// publishedAt, duration, viewCount }], complete } (complete: every archive the channel has).
async function getArchives (userID, { max = 300, ...options } = {}) {
  const videos = []
  let cursor = null
  do {
    const params = { user_id: userID, type: 'archive', first: '100', ...(cursor ? { after: cursor } : {}) }
    const json = await helix('videos', params, options)
    for (const v of json.data || []) {
      videos.push({ id: v.id, title: v.title, description: v.description, url: v.url, publishedAt: v.published_at || v.created_at, duration: v.duration, viewCount: v.view_count })
    }
    cursor = json.pagination?.cursor || null
  } while (cursor && videos.length < max)
  return { videos: videos.slice(0, max), complete: !cursor }
}

// For tests: forget the token.
function reset () {
  token = null
}

module.exports = { configured, accessToken, getChannels, getArchives, TwitchError, reset }
