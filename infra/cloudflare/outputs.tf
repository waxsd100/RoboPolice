output "bot_environment" {
  description = "What the bot needs on the hosting platform (CF_ACCESS_CLIENT_SECRET goes to Secret Manager)"
  value = {
    CLOUDFLARE_AI_GATEWAY_URL = "https://${var.gateway_domain}"
    CF_ACCESS_CLIENT_ID       = "the Client ID of service token ${var.access_service_token_id}"
  }
}

output "access_application_id" {
  description = "The Access application in front of the gateway domain"
  value       = cloudflare_zero_trust_access_application.gateway.id
}
