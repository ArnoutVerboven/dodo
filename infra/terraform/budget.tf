# Lifetime cost cap. Alerts go to the billing-alerts topic, where the killSwitch function
# halts processing and, past the detach threshold, unlinks billing.

resource "google_pubsub_topic" "billing_alerts" {
  name       = "billing-alerts"
  depends_on = [google_project_service.this]
}

resource "google_billing_budget" "cap" {
  billing_account = var.billing_account
  display_name    = "dodo hard cap"

  budget_filter {
    projects = ["projects/${local.project_number}"]
    # Credits are excluded so the budget tracks gross cost: it fires earlier, never later.
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
    custom_period {
      start_date {
        year  = var.budget_start.year
        month = var.budget_start.month
        day   = var.budget_start.day
      }
      end_date {
        year  = var.budget_end.year
        month = var.budget_end.month
        day   = var.budget_end.day
      }
    }
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.8, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.billing_alerts.id
    schema_version = "1.0"
  }
}
