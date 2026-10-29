output "wif_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_sa" {
  value = google_service_account.deployer.email
}

output "worker_job" {
  value = google_cloud_run_v2_job.worker.id
}

output "worker_browser_job" {
  value = google_cloud_run_v2_job.worker_browser.id
}
