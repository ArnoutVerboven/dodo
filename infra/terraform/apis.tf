locals {
  services = toset([
    "firestore.googleapis.com",
    "firebase.googleapis.com",
    "firebaserules.googleapis.com",
    "firebasehosting.googleapis.com",
    "identitytoolkit.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "cloudscheduler.googleapis.com",
    "monitoring.googleapis.com",
    "apikeys.googleapis.com",
    "fcm.googleapis.com",
    "fcmregistrations.googleapis.com",
  ])
}

resource "google_project_service" "this" {
  for_each = local.services
  service  = each.value

  # Never switch an API off by removing it here: that can break running services.
  disable_on_destroy         = false
  disable_dependent_services = false
}
