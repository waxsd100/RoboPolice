// Cloudflare AI Gateway: where requests through it go, and the headers that authenticate them.
// Shared by every outbound API the bot routes through the gateway (Gemini, and YouTube as a
// custom provider).
//
// Either the gateway's own custom domain (CLOUDFLARE_AI_GATEWAY_URL, e.g.
// https://ai-gateway.example.com: no account or gateway ID in the path), or the default endpoint
// built from CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_ID. A custom domain behind Cloudflare
// Access (Zero Trust) is reached with a service token: CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET.

function customBase () {
  const raw = String(process.env.CLOUDFLARE_AI_GATEWAY_URL || '').trim()
  if (!raw) return null
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return url.replace(/\/+$/, '')
}

function gatewayURL (providerPath) {
  const base = customBase()
  if (base) return `${base}/${providerPath}`
  return `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_ID}/${providerPath}`
}

// The gateway's own token, sent only when set: only an authenticated gateway needs it. And the
// Cloudflare Access service token, when the gateway's domain is behind Access.
function gatewayAuthHeaders () {
  const headers = {}
  if (process.env.CLOUDFLARE_AI_GATEWAY_TOKEN) headers['cf-aig-authorization'] = `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}`
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
  }
  return headers
}

function isGatewayConfigured () {
  return !!(customBase() || (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_GATEWAY_ID))
}

module.exports = { gatewayURL, gatewayAuthHeaders, isGatewayConfigured }
