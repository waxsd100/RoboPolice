variable "account_id" {
  description = "Cloudflare account that holds the AI Gateway and Zero Trust"
  type        = string
}

variable "gateway_id" {
  description = "ID (name) of the AI Gateway the bot sends Gemini requests through"
  type        = string
  default     = "robopolice"
}

variable "gateway_domain" {
  description = "The gateway's custom domain, behind Cloudflare Access (CLOUDFLARE_AI_GATEWAY_URL on the bot)"
  type        = string
  default     = "ai-gateway.skyblock.jp"
}

# Made in the dashboard (Zero Trust > Access > Service credentials > Service Tokens), not here, so
# its secret never ends up in Terraform state. Its Client ID goes to CF_ACCESS_CLIENT_ID on the bot,
# its secret to Secret Manager as CF_ACCESS_CLIENT_SECRET (../terraform).
variable "access_service_token_id" {
  description = "ID of the Access service token the bot authenticates with"
  type        = string
}

variable "allowed_emails" {
  description = "People who may open the gateway domain in a browser (for checking it by hand)"
  type        = list(string)
  default     = []
}

variable "gateway_authentication" {
  description = "Whether the gateway itself also requires its token (cf-aig-authorization)"
  type        = bool
  default     = true
}

variable "gateway_collect_logs" {
  description = "Whether the gateway keeps request logs (shown in the dashboard)"
  type        = bool
  default     = true
}

variable "rate_limit" {
  description = "Requests allowed per rate_limit_interval_seconds across the gateway (0: no limit)"
  type        = number
  default     = 0
}

variable "rate_limit_interval_seconds" {
  description = "Window of rate_limit"
  type        = number
  default     = 0
}
