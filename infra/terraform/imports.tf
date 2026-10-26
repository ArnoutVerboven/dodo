# Adopt resources that bootstrap.sh and the deploy workflow created before Terraform. Each
# import runs only when lookup.sh found the resource; once it is in state the import is a
# no-op, and on a fresh project nothing is imported and Terraform creates everything.
# Service accounts need no import (create_ignore_already_exists), nor do IAM grants and
# APIs (adding an existing grant or enabling an enabled API changes nothing).

import {
  to = google_iam_workload_identity_pool.github
  id = "projects/${var.project_id}/locations/global/workloadIdentityPools/github"
}

import {
  to = google_iam_workload_identity_pool_provider.github
  id = "projects/${var.project_id}/locations/global/workloadIdentityPools/github/providers/github-oidc"
}

import {
  for_each = toset(compact([var.adopt.topic]))
  to       = google_pubsub_topic.billing_alerts
  id       = each.value
}

import {
  for_each = toset(compact([var.adopt.budget]))
  to       = google_billing_budget.cap
  id       = each.value
}

import {
  for_each = toset(compact([var.adopt.registry]))
  to       = google_artifact_registry_repository.dodo
  id       = each.value
}

import {
  for_each = toset(compact([var.adopt.worker_key]))
  to       = google_apikeys_key.worker
  id       = "projects/${var.project_id}/locations/global/keys/${each.value}"
}

import {
  for_each = toset(compact([var.adopt.job]))
  to       = google_cloud_run_v2_job.worker
  id       = each.value
}
