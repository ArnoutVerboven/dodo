terraform {
  # 1.7+ for import blocks with for_each (see imports.tf).
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8"
    }
  }

  # The bucket is created by infra/bootstrap.sh and passed at init:
  #   terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "dodo"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  # The Billing Budgets and API Keys APIs need a quota project for service account callers.
  user_project_override = true
  billing_project       = var.project_id
}

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number = data.google_project.this.number
  sa_domain      = "${var.project_id}.iam.gserviceaccount.com"
}
