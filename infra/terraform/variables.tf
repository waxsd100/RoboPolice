variable "project_id" {
  description = "Google Cloud project that holds the secrets"
  type        = string
}

# Only what would do real damage if it leaked: the bot token (full control of the bot), the AI
# Gateway token (spends on Gemini) and the YouTube API key (used by others against the project's
# quota and billing). Everything else stays on the hosting platform, including the
# database and Redis passwords Railway creates and injects for its own Postgres and Redis. Add more
# here if needed.
variable "secret_names" {
  description = "Environment variables to keep in Secret Manager instead of on the hosting platform"
  type        = list(string)
  default = [
    "BOT_TOKEN",
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
    "YOUTUBE_API_KEY",
  ]
}

# Secret Manager has no folders or groups: this app's secrets are told apart by this prefix in their
# IDs and by the app=robopolice label.
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
