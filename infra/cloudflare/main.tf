# Cloudflare side of the bot's Gemini traffic: the AI Gateway, and Cloudflare Access (Zero Trust) in
# front of its custom domain, so only the bot (with its service token) and the people named can
# reach it.
#
# The custom domain itself (AI Gateway > the gateway > Settings > Custom domain) has no Terraform
# resource yet: add it in the dashboard, which also creates its DNS record.

resource "cloudflare_ai_gateway" "bot" {
  account_id                 = var.account_id
  id                         = var.gateway_id
  authentication             = var.gateway_authentication
  collect_logs               = var.gateway_collect_logs
  cache_ttl                  = 0
  cache_invalidate_on_update = true
  rate_limiting_limit        = var.rate_limit
  rate_limiting_interval     = var.rate_limit_interval_seconds
  rate_limiting_technique    = "fixed"
}

# The bot: requests carrying the service token (CF-Access-Client-Id / CF-Access-Client-Secret).
resource "cloudflare_zero_trust_access_policy" "bot" {
  account_id = var.account_id
  name       = "RoboPolice bot (service token)"
  decision   = "non_identity"
  include = [{
    service_token = {
      token_id = var.access_service_token_id
    }
  }]
}

# People, to open the domain in a browser. None by default.
resource "cloudflare_zero_trust_access_policy" "people" {
  count      = length(var.allowed_emails) == 0 ? 0 : 1
  account_id = var.account_id
  name       = "RoboPolice AI Gateway (people)"
  decision   = "allow"
  include    = [for email in var.allowed_emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_application" "gateway" {
  account_id       = var.account_id
  name             = "RoboPolice AI Gateway"
  type             = "self_hosted"
  domain           = var.gateway_domain
  session_duration = "24h"
  # A request without a valid token gets 401, not a login page: the bot is not a browser.
  service_auth_401_redirect = true

  destinations = [{
    type = "public"
    uri  = var.gateway_domain
  }]

  policies = concat(
    [{ id = cloudflare_zero_trust_access_policy.bot.id, precedence = 1 }],
    [for p in cloudflare_zero_trust_access_policy.people : { id = p.id, precedence = 2 }]
  )
}
