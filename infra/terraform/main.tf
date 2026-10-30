# Secret Manager for RoboPolice: one secret per environment variable, and a service account that
# can read only those. Secret values are not managed here, so they never end up in Terraform state:
# add them with `gcloud secrets versions add` (see the add_value_commands output).

locals {
  secret_ids = { for name in var.secret_names : name => "${var.secret_id_prefix}${lower(replace(name, "_", "-"))}" }
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_secret_manager_secret" "env" {
  for_each  = local.secret_ids
  secret_id = each.value

  labels = {
    app     = "robopolice"
    env_var = lower(each.key)
  }

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_service_account" "runtime" {
  account_id   = var.service_account_id
  display_name = "RoboPolice runtime (reads its secrets)"
}

# Read access to these secrets only, not to the project's other secrets.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.env
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
