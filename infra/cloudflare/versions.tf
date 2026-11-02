terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 5.19 added cloudflare_ai_gateway.
      version = "~> 5.19"
    }
  }
}

# The API token comes from CLOUDFLARE_API_TOKEN. It needs: AI Gateway Edit, Access: Apps and
# Policies Edit (account).
provider "cloudflare" {}
