// Where gateway requests go: the default endpoint, or the gateway's custom domain behind Access.
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { gatewayURL, gatewayAuthHeaders, isGatewayConfigured } = require('../../src/bot/utils/aiGateway')

const NAMES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID', 'CLOUDFLARE_AI_GATEWAY_URL', 'CLOUDFLARE_AI_GATEWAY_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']
const saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]))
afterEach(() => { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] } })
const clear = () => { for (const n of NAMES) delete process.env[n] }

test('the default endpoint, from the account and gateway IDs', () => {
  clear()
  assert.equal(isGatewayConfigured(), false)
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'gw'
  assert.equal(isGatewayConfigured(), true)
  assert.equal(gatewayURL('google-ai-studio/v1beta/models/m:generateContent'), 'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models/m:generateContent')
  assert.deepEqual(gatewayAuthHeaders(), {})
})

test('a custom domain needs no IDs, and its path starts with the provider', () => {
  clear()
  process.env.CLOUDFLARE_AI_GATEWAY_URL = 'ai-gateway.skyblock.jp/'
  assert.equal(isGatewayConfigured(), true)
  assert.equal(gatewayURL('google-ai-studio/v1beta/cachedContents'), 'https://ai-gateway.skyblock.jp/google-ai-studio/v1beta/cachedContents')
  process.env.CLOUDFLARE_AI_GATEWAY_URL = 'https://ai-gateway.skyblock.jp'
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'gw'
  assert.equal(gatewayURL('custom-youtube/youtube/v3'), 'https://ai-gateway.skyblock.jp/custom-youtube/youtube/v3', 'the domain wins')
  // A call that may stay silent past Cloudflare's 100 seconds goes to the default endpoint.
  assert.equal(gatewayURL('google-ai-studio/v1beta/x', { direct: true }), 'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/x')
  delete process.env.CLOUDFLARE_AI_GATEWAY_ID
  assert.equal(gatewayURL('google-ai-studio/v1beta/x', { direct: true }), 'https://ai-gateway.skyblock.jp/google-ai-studio/v1beta/x', 'the domain when the IDs are not there')
})

test('behind Cloudflare Access: the service token goes with the gateway token', () => {
  clear()
  process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'tok'
  process.env.CF_ACCESS_CLIENT_ID = 'id.access'
  process.env.CF_ACCESS_CLIENT_SECRET = 'shh'
  assert.deepEqual(gatewayAuthHeaders(), { 'cf-aig-authorization': 'Bearer tok', 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'shh' })
  delete process.env.CF_ACCESS_CLIENT_SECRET
  assert.deepEqual(gatewayAuthHeaders(), { 'cf-aig-authorization': 'Bearer tok' }, 'both halves or neither')
})
