variable "project_id" {
  description = "Google Cloud project that holds the secrets"
  type        = string
}

variable "secret_names" {
  description = "Environment variables to keep in Secret Manager instead of on the hosting platform"
  type        = list(string)
  default = [
    "BOT_TOKEN",
    "DISCORD_WEBHOOK_URL",
    "PGPASSWORD",
    "REDIS_PASSWORD",
    "AES_KEY",
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
    "YOUTUBE_API_KEY",
  ]
}

variable "secret_id_prefix" {
  description = "Prefix of the secret IDs (BOT_TOKEN becomes <prefix>bot-token)"
  type        = string
  default     = "robopolice-"
}

variable "service_account_id" {
  description = "ID of the service account the bot reads the secrets as"
  type        = string
  default     = "robopolice-runtime"
}
