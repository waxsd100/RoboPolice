output "service_account_email" {
  description = "The account the bot reads secrets as"
  value       = google_service_account.runtime.email
}

output "gcp_secrets" {
  description = "Value for the GCP_SECRETS environment variable on the hosting platform"
  value       = join(",", [for name, id in local.secret_ids : "${name}=${id}"])
}

output "add_value_commands" {
  description = "Commands that store each secret's value (each reads the value from standard input)"
  value       = [for name, id in local.secret_ids : "printf '%s' \"$${name}\" | gcloud secrets versions add ${id} --project ${var.project_id} --data-file=-"]
}

output "create_key_command" {
  description = "Command that creates the service account key for GCP_SERVICE_ACCOUNT_KEY"
  value       = "gcloud iam service-accounts keys create robopolice-key.json --iam-account ${google_service_account.runtime.email}"
}
