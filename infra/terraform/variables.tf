variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "github_repo" {
  description = "owner/name of the repository whose GitHub Actions may deploy."
  type        = string
}

variable "billing_account" {
  description = "Billing account id (without the billingAccounts/ prefix). Looked up by lookup.sh."
  type        = string
}

variable "budget_amount" {
  description = "Lifetime cap, in the billing account's currency."
  type        = number
  default     = 50
}

variable "budget_currency" {
  type    = string
  default = "EUR"
}

# The cap is a lifetime total: one long custom period instead of a monthly reset.
variable "budget_start" {
  type = object({ year = number, month = number, day = number })
}

variable "budget_end" {
  type    = object({ year = number, month = number, day = number })
  default = { year = 2030, month = 12, day = 31 }
}

variable "worker_image" {
  description = "Image used only when Terraform creates the job. The deploy workflow sets the real one."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/job:latest"
}

variable "adopt" {
  description = <<-EOT
    Import ids of resources that already exist but were created outside Terraform, found by
    lookup.sh. An empty string means the resource does not exist yet and Terraform creates it.
  EOT
  type = object({
    budget     = optional(string, "")
    topic      = optional(string, "")
    registry   = optional(string, "")
    job        = optional(string, "")
    worker_key = optional(string, "")
  })
  default = {}
}
