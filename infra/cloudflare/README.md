# Cloudflare: AI Gateway and Access

The bot sends Gemini requests through Cloudflare AI Gateway on its custom domain
(`ai-gateway.skyblock.jp`), which Cloudflare Access (Zero Trust) guards: only requests with the bot's
service token, and the people listed, get through. YouTube API calls go direct and are not involved.

## What is managed here

| Resource | What |
|---|---|
| `cloudflare_ai_gateway.bot` | The gateway: its own token requirement, logs, rate limit |
| `cloudflare_zero_trust_access_policy.bot` | Service Auth: requests with the bot's service token |
| `cloudflare_zero_trust_access_policy.people` | Optional: people who may open the domain in a browser |
| `cloudflare_zero_trust_access_application.gateway` | The Access application on the domain, with both policies |

Not managed here, by design or for lack of a resource:

- **The service token** (Zero Trust > Access > Service credentials > Service Tokens): made in the
  dashboard so its secret never sits in Terraform state, like the bot's other secrets (`../terraform`
  stores none). Its ID goes to `access_service_token_id`.
- **The gateway's custom domain** (AI Gateway > gateway > Settings > Custom domain): no Terraform
  resource yet.

## Use

The API token (`CLOUDFLARE_API_TOKEN`) needs AI Gateway: Edit and Access: Apps and Policies: Edit on
the account.

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init
```

The gateway and the Access application exist already (made in the dashboard): import them before the
first apply, or Terraform makes new ones.

```bash
terraform import cloudflare_ai_gateway.bot "<account_id>/<gateway_id>"
terraform import cloudflare_zero_trust_access_application.gateway "accounts/<account_id>/<application_id>"
```

Existing policies attached to the application by hand: import them too, or detach them after the
first apply. Then:

```bash
terraform plan
terraform apply
```

## The bot's side

| Variable | Value | Where |
|---|---|---|
| `CLOUDFLARE_AI_GATEWAY_URL` | `https://ai-gateway.skyblock.jp` | Hosting platform |
| `CF_ACCESS_CLIENT_ID` | the service token's Client ID | Secret Manager (`../terraform`) |
| `CF_ACCESS_CLIENT_SECRET` | the service token's Client Secret | Secret Manager (`../terraform`) |

Both secrets are created by `../terraform`, which also lets the bot's service account read them.
A secret made by hand in the console has no such grant (the bot gets HTTP 403 reading it): bring
it under Terraform before applying, so it is not created twice:

```bash
cd ../terraform
terraform import 'google_secret_manager_secret.env["CF_ACCESS_CLIENT_ID"]' projects/<project>/secrets/robopolice-cf-access-client-id
terraform import 'google_secret_manager_secret.env["CF_ACCESS_CLIENT_SECRET"]' projects/<project>/secrets/robopolice-cf-access-client-secret
terraform apply
```
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | the gateway's token, while `gateway_authentication` is on | Secret Manager |
