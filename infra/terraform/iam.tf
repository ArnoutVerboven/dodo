# Service accounts and their roles. Bindings are additive (iam_member), so Terraform makes
# sure every grant below exists but leaves grants made elsewhere alone. The identities CI runs
# as (deployer, terraform, planner) and their Workload Identity bindings start in
# infra/bootstrap.sh; Terraform takes over the deployer's roles from there.

resource "google_service_account" "killswitch" {
  account_id                   = "dodo-killswitch"
  display_name                 = "dodo kill switch"
  create_ignore_already_exists = true
  depends_on                   = [google_project_service.this]
}

# The only identity allowed to call Vertex AI (runs the gateway/control-plane functions).
resource "google_service_account" "gateway" {
  account_id                   = "dodo-gateway"
  display_name                 = "dodo model gateway + control plane"
  create_ignore_already_exists = true
  depends_on                   = [google_project_service.this]
}

# Deliberately NO roles: any process in the worker container can read its token.
resource "google_service_account" "worker" {
  account_id                   = "dodo-worker"
  display_name                 = "dodo worker (no roles by design)"
  create_ignore_already_exists = true
  depends_on                   = [google_project_service.this]
}

# Created by bootstrap.sh (GitHub Actions needs it before Terraform runs); adopted here.
resource "google_service_account" "deployer" {
  account_id                   = "dodo-deployer"
  display_name                 = "dodo deployer (GitHub Actions)"
  create_ignore_already_exists = true
  depends_on                   = [google_project_service.this]
}

locals {
  compute_sa   = "${local.project_number}-compute@developer.gserviceaccount.com"
  appspot_sa   = "${var.project_id}@appspot.gserviceaccount.com"
  pubsub_agent = "service-${local.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  project_roles = {
    killswitch = {
      member = google_service_account.killswitch.member
      roles = [
        "roles/billing.projectManager", # unlink billing from this project
        "roles/datastore.user",         # set settings/global.halted
        "roles/eventarc.eventReceiver",
        "roles/run.invoker",
        "roles/run.developer", # cancel running worker executions
      ]
    }
    gateway = {
      member = google_service_account.gateway.member
      roles = [
        "roles/aiplatform.user",
        "roles/datastore.user",
        "roles/firebaseauth.admin", # mint/revoke per-run identities
        "roles/run.developer",      # start worker executions
        "roles/eventarc.eventReceiver",
        "roles/run.invoker",
        "roles/storage.objectAdmin", # archive run sessions and traces
      ]
    }
    deployer = {
      member = google_service_account.deployer.member
      roles = [
        "roles/firebase.admin",
        "roles/cloudfunctions.admin",
        "roles/run.admin",
        "roles/artifactregistry.admin",
        "roles/serviceusage.serviceUsageConsumer",
        "roles/cloudbuild.builds.editor",
        "roles/eventarc.admin",
        "roles/pubsub.editor",
        "roles/secretmanager.viewer",
        "roles/storage.admin",
        "roles/monitoring.alertPolicyEditor",
        "roles/monitoring.notificationChannelEditor",
        "roles/secretmanager.admin",
        "roles/cloudscheduler.admin",
        "roles/serviceusage.apiKeysAdmin",
      ]
    }
    # Service agents needed by Cloud Functions (2nd gen) deploys. The deployer may not change
    # project IAM, so they are granted here.
    pubsub_agent = {
      member = "serviceAccount:${local.pubsub_agent}"
      roles  = ["roles/iam.serviceAccountTokenCreator"]
    }
    compute = {
      member = "serviceAccount:${local.compute_sa}"
      roles  = ["roles/run.invoker", "roles/eventarc.eventReceiver"]
    }
  }

  project_bindings = merge([
    for who, b in local.project_roles : {
      for role in b.roles : "${who} ${role}" => { member = b.member, role = role }
    }
  ]...)
}

resource "google_project_iam_member" "this" {
  for_each   = local.project_bindings
  project    = var.project_id
  role       = each.value.role
  member     = each.value.member
  depends_on = [google_project_service.this]
}

# createCustomToken in Cloud Functions signs with the IAM signBlob API: the gateway must be
# allowed to create tokens as itself.
resource "google_service_account_iam_member" "gateway_signs_as_itself" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_service_account.gateway.member
}

# The deployer may act only as the runtime accounts it deploys, not as any account in the
# project (in particular not as itself or accounts with billing rights).
locals {
  deployer_acts_as = {
    killswitch = google_service_account.killswitch.name
    gateway    = google_service_account.gateway.name
    worker     = google_service_account.worker.name
    compute    = "projects/${var.project_id}/serviceAccounts/${local.compute_sa}"
    # The Firebase CLI checks ActAs on the App Engine default account for functions deploys.
    appspot = "projects/${var.project_id}/serviceAccounts/${local.appspot_sa}"
  }
}

resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each           = local.deployer_acts_as
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}
