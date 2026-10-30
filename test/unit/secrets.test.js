const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { loadSecrets, parseMapping, parseKey } = require('../../src/miscellaneous/secrets')

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY = {
  type: 'service_account',
  project_id: 'robopolice-prod',
  client_email: 'robopolice-runtime@robopolice-prod.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
}
const quiet = { log () {}, warn () {} }

// A fake Google: checks the signed JWT, then serves secrets by resource name.
function fakeGoogle (secrets) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') {
      const assertion = new URLSearchParams(init.body).get('assertion')
      const [header, claims, signature] = assertion.split('.')
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), 'JWT is signed with the key')
      const body = JSON.parse(Buffer.from(claims, 'base64url').toString())
      assert.equal(body.iss, KEY.client_email)
      assert.equal(body.scope, 'https://www.googleapis.com/auth/cloud-platform')
      return { ok: true, json: async () => ({ access_token: 'tok' }) }
    }
    assert.equal(init.headers.Authorization, 'Bearer tok')
    const resource = url.replace('https://secretmanager.googleapis.com/v1/', '').replace(/:access$/, '')
    if (!(resource in secrets)) return { ok: false, status: 404, text: async () => 'NOT_FOUND' }
    return { ok: true, json: async () => ({ payload: { data: Buffer.from(secrets[resource]).toString('base64') } }) }
  }
  return { fetchImpl, calls }
}

describe('parseMapping', () => {
  test('takes secret IDs, full names and versions', () => {
    assert.deepEqual(parseMapping('BOT_TOKEN=robopolice-bot-token, PGPASSWORD=projects/other/secrets/pg\nAES_KEY=projects/p/secrets/aes/versions/3', 'robopolice-prod'), [
      { name: 'BOT_TOKEN', resource: 'projects/robopolice-prod/secrets/robopolice-bot-token/versions/latest' },
      { name: 'PGPASSWORD', resource: 'projects/other/secrets/pg/versions/latest' },
      { name: 'AES_KEY', resource: 'projects/p/secrets/aes/versions/3' }
    ])
  })

  test('rejects anything else', () => {
    assert.throws(() => parseMapping('BOT_TOKEN', 'p'), /NAME=secret-id/)
    assert.throws(() => parseMapping('1BAD=x', 'p'), /NAME=secret-id/)
  })
})

describe('parseKey', () => {
  test('accepts the JSON as is or base64-encoded', () => {
    assert.equal(parseKey(JSON.stringify(KEY)).client_email, KEY.client_email)
    assert.equal(parseKey(Buffer.from(JSON.stringify(KEY)).toString('base64')).client_email, KEY.client_email)
    assert.throws(() => parseKey('not a key'), /service account JSON key/)
    assert.throws(() => parseKey('{"a":1}'), /no client_email/)
  })
})

describe('loadSecrets', () => {
  test('does nothing without GCP_SECRETS', async () => {
    const env = { BOT_TOKEN: 'x' }
    assert.deepEqual(await loadSecrets({ env, fetchImpl: () => assert.fail('no request'), log: quiet }), [])
    assert.deepEqual(env, { BOT_TOKEN: 'x' })
  })

  test('reads every secret into the environment and removes the key from it', async () => {
    const { fetchImpl, calls } = fakeGoogle({
      'projects/robopolice-prod/secrets/robopolice-bot-token/versions/latest': 'discord-token',
      'projects/robopolice-prod/secrets/robopolice-aes-key/versions/latest': 'aes'
    })
    const env = {
      GCP_SECRETS: 'BOT_TOKEN=robopolice-bot-token,AES_KEY=robopolice-aes-key',
      GCP_SERVICE_ACCOUNT_KEY: Buffer.from(JSON.stringify(KEY)).toString('base64'),
      PGHOST: 'db'
    }
    assert.deepEqual(await loadSecrets({ env, fetchImpl, log: quiet }), ['BOT_TOKEN', 'AES_KEY'])
    assert.deepEqual(env, { PGHOST: 'db', BOT_TOKEN: 'discord-token', AES_KEY: 'aes' })
    assert.equal(calls.length, 3, 'one token, then one read per secret')
  })

  test('keeps a value already in the environment and says to remove it', async (t) => {
    const { fetchImpl } = fakeGoogle({ 'projects/robopolice-prod/secrets/s/versions/latest': 'from-gcp' })
    const warn = t.mock.fn()
    const env = { GCP_SECRETS: 'BOT_TOKEN=s', GCP_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY), BOT_TOKEN: 'from-env' }
    assert.deepEqual(await loadSecrets({ env, fetchImpl, log: { log () {}, warn } }), [])
    assert.equal(env.BOT_TOKEN, 'from-env')
    assert.match(warn.mock.calls[0].arguments[0], /BOT_TOKEN is set in the environment too/)
  })

  test('fails when a secret can\'t be read or the key is missing, without leaking the value', async () => {
    const { fetchImpl } = fakeGoogle({})
    await assert.rejects(
      loadSecrets({ env: { GCP_SECRETS: 'BOT_TOKEN=missing', GCP_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY) }, fetchImpl, log: quiet }),
      /Could not read projects\/robopolice-prod\/secrets\/missing\/versions\/latest: HTTP 404/
    )
    await assert.rejects(loadSecrets({ env: { GCP_SECRETS: 'BOT_TOKEN=x' }, fetchImpl, log: quiet }), /GCP_SERVICE_ACCOUNT_KEY is not/)
  })

  test('uses GCP_PROJECT_ID over the key\'s project', async () => {
    const { fetchImpl } = fakeGoogle({ 'projects/shared/secrets/s/versions/latest': 'v' })
    const env = { GCP_SECRETS: 'X=s', GCP_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY), GCP_PROJECT_ID: 'shared' }
    await loadSecrets({ env, fetchImpl, log: quiet })
    assert.equal(env.X, 'v')
    assert.equal(env.GCP_PROJECT_ID, 'shared')
  })
})
