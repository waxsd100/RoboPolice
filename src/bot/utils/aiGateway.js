// Cloudflare AI Gateway: where requests through it go, and the headers that authenticate them.
// Shared by every outbound API the bot routes through the gateway (Gemini, and YouTube as a
// custom provider).

function gatewayURL (providerPath) {
  return `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_ID}/${providerPath}`
}

// The gateway's own token, sent only when set: only an authenticated gateway needs it.
function gatewayAuthHeaders () {
  return process.env.CLOUDFLARE_AI_GATEWAY_TOKEN
    ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` }
    : {}
}

function isGatewayConfigured () {
  return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_GATEWAY_ID)
}

module.exports = { gatewayURL, gatewayAuthHeaders, isGatewayConfigured }
