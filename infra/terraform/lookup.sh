#!/usr/bin/env bash
# Finds the values Terraform cannot know by itself and prints them as TF_VAR_* lines:
# the billing account, and the import ids of resources created before Terraform (adopt).
# Used by the Terraform workflows; locally:
#   export $(./infra/terraform/lookup.sh dodo-512722)
set -euo pipefail
PROJECT="${1:?usage: lookup.sh PROJECT_ID}"
REGION="${2:-europe-west1}"

ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"
ACCOUNT="${ACCOUNT#billingAccounts/}"
[[ -n "$ACCOUNT" ]] || { echo "Billing is not linked to $PROJECT" >&2; exit 1; }

exists() { "$@" >/dev/null 2>&1; }
TOPIC="" REGISTRY="" JOB=""
exists gcloud pubsub topics describe billing-alerts --project "$PROJECT" &&
  TOPIC="projects/$PROJECT/topics/billing-alerts"
exists gcloud artifacts repositories describe dodo --location "$REGION" --project "$PROJECT" &&
  REGISTRY="projects/$PROJECT/locations/$REGION/repositories/dodo"
exists gcloud run jobs describe dodo-worker --region "$REGION" --project "$PROJECT" &&
  JOB="projects/$PROJECT/locations/$REGION/jobs/dodo-worker"
BUDGET="$(gcloud billing budgets list --billing-account "$ACCOUNT" \
  --filter="displayName='dodo hard cap'" --format='value(name)' | head -1)"
KEY="$(gcloud services api-keys list --project "$PROJECT" \
  --filter='displayName=dodo-worker' --format='value(name)' 2>/dev/null | head -1)"
KEY="${KEY##*/}"

echo "TF_VAR_billing_account=$ACCOUNT"
printf 'TF_VAR_adopt={"budget":"%s","topic":"%s","registry":"%s","job":"%s","worker_key":"%s"}\n' \
  "$BUDGET" "$TOPIC" "$REGISTRY" "$JOB" "$KEY"
