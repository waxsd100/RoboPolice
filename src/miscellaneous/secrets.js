// Loads secrets from Google Cloud Secret Manager into process.env at startup, so the hosting
// platform holds only a narrowly scoped service account key instead of every secret.
//
//   GCP_SECRETS              BOT_TOKEN=robopolice-bot-token,PGPASSWORD=robopolice-pgpassword
//                            (environment variable = secret ID; a full projects/…/secrets/…[/versions/…]
//                            name works too). The latest version is read unless one is named.
//   GCP_SERVICE_ACCOUNT_KEY  The service account's JSON key, as is or base64-encoded.
//   GCP_PROJECT_ID           Optional. Defaults to the key's project.
//
// Without GCP_SECRETS nothing happens and the environment is used as it is. Both settings are
// removed from process.env once read, so cluster workers and anything else started later never
// see the key; the secrets they need are in their inherited environment by then.
//
// Plain Node (crypto and fetch) rather than the Google client libraries: two REST calls do not
// justify the gRPC stack.
const crypto = require('crypto')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SECRET_MANAGER = 'https://secretmanager.googleapis.com/v1'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const TIMEOUT_MS = 15000

function parseKey (raw) {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  let key
  try {
    key = JSON.parse(text)
  } catch (_) {
    throw new Error('GCP_SERVICE_ACCOUNT_KEY is not a service account JSON key (as is or base64)')
  }
  if (!key.client_email || !key.private_key) throw new Error('GCP_SERVICE_ACCOUNT_KEY has no client_email or private_key')
  return key
}

// [{ name, resource }] from "NAME=secret-id,…".
function parseMapping (text, projectID) {
  return text.split(/[,\n]/).map(s => s.trim()).filter(Boolean).map(entry => {
    const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/)
    if (!match) throw new Error(`GCP_SECRETS entry "${entry}" is not NAME=secret-id`)
    const [, name, ref] = match
    let resource = ref.startsWith('projects/') ? ref : `projects/${projectID}/secrets/${ref}`
    if (!/\/versions\/[^/]+$/.test(resource)) resource += '/versions/latest'
    return { name, resource }
  })
}

const base64url = data => Buffer.from(data).toString('base64url')

// An OAuth access token for the service account (the JWT bearer grant).
async function accessToken (key, fetchImpl) {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 600
  }))}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()).access_token
}

async function accessSecret (resource, token, fetchImpl) {
  const res = await fetchImpl(`${SECRET_MANAGER}/${resource}:access`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Could not read ${resource}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  return Buffer.from((await res.json()).payload.data, 'base64').toString('utf8')
}

// Resolves to the names loaded. Throws if any secret can't be read: starting without one would fail
// later and less clearly.
async function loadSecrets ({ env = process.env, fetchImpl = global.fetch, log = console } = {}) {
  const mapping = env.GCP_SECRETS
  if (!mapping) return []
  if (!env.GCP_SERVICE_ACCOUNT_KEY) throw new Error('GCP_SECRETS is set but GCP_SERVICE_ACCOUNT_KEY is not')
  const key = parseKey(env.GCP_SERVICE_ACCOUNT_KEY)
  const projectID = env.GCP_PROJECT_ID || key.project_id
  const wanted = parseMapping(mapping, projectID)
  delete env.GCP_SECRETS
  delete env.GCP_SERVICE_ACCOUNT_KEY

  const token = await accessToken(key, fetchImpl)
  const values = await Promise.all(wanted.map(({ resource }) => accessSecret(resource, token, fetchImpl)))
  const loaded = []
  wanted.forEach(({ name }, i) => {
    // A value still set on the platform wins, so a deploy never changes behavior by surprise, but
    // it should be removed there: that is the point of keeping it here.
    if (env[name]) {
      log.warn(`[SECRETS]: ${name} is set in the environment too; using that value. Remove it from the environment.`)
      return
    }
    env[name] = values[i]
    loaded.push(name)
  })
  log.log(`[SECRETS]: Loaded ${loaded.length} secret(s) from Secret Manager: ${loaded.join(', ')}`)
  return loaded
}

module.exports = { loadSecrets, parseMapping, parseKey }
