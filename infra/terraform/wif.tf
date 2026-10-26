# Keyless GitHub Actions auth. Each CI identity is bound to one workflow by name, and only
# runs on main may get a token, except the read-only plan workflow, which runs on PRs.
# bootstrap.sh creates the same pool and provider (Terraform cannot run without them);
# keep the two in step.

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.workflow"   = "assertion.workflow"
  }
  attribute_condition = "assertion.repository=='${var.github_repo}' && (assertion.ref=='refs/heads/main' || assertion.workflow=='terraform-plan')"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  wif_principal_set = "principalSet://iam.googleapis.com/projects/${local.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}"
}

# Authoritative for this role: only the Deploy workflow may act as the deployer.
resource "google_service_account_iam_binding" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  members            = ["${local.wif_principal_set}/attribute.workflow/Deploy"]
}
