resource "google_artifact_registry_repository" "dodo" {
  repository_id = "dodo"
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.this]
}

# The browser key is restricted to the web app's domains, which blocks sign-in from Cloud
# Run. The worker gets its own key, restricted by API instead of by website.
resource "google_apikeys_key" "worker" {
  # Keys created by the old deploy workflow have a generated id; keep it when adopting one.
  name         = var.adopt.worker_key != "" ? var.adopt.worker_key : "dodo-worker"
  display_name = "dodo-worker"

  restrictions {
    dynamic "api_targets" {
      for_each = [
        "identitytoolkit.googleapis.com",
        "securetoken.googleapis.com",
        "firestore.googleapis.com",
        "firebasestorage.googleapis.com",
      ]
      content {
        service = api_targets.value
      }
    }
  }

  depends_on = [google_project_service.this]
}

locals {
  # Same Firebase config the web app is built with.
  web_env = file("${path.module}/../../apps/web/.env.production")
}

# The deploy workflow builds the image and points the job at it (gcloud run jobs update
# --image); everything else about the job lives here.
resource "google_cloud_run_v2_job" "worker" {
  name     = "dodo-worker"
  location = var.region

  template {
    task_count = 1

    template {
      service_account = google_service_account.worker.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        image = var.worker_image

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        env {
          name  = "FIREBASE_API_KEY"
          value = google_apikeys_key.worker.key_string
        }
        env {
          name  = "FIREBASE_PROJECT_ID"
          value = regex("(?m)^VITE_FIREBASE_PROJECT_ID=(.+)$", local.web_env)[0]
        }
        env {
          name  = "FIREBASE_APP_ID"
          value = regex("(?m)^VITE_FIREBASE_APP_ID=(.+)$", local.web_env)[0]
        }
        env {
          name  = "FUNCTIONS_REGION"
          value = var.region
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.this]
}
