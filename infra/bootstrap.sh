#!/usr/bin/env bash
# One-time setup of the GCP project for dodo: only what Terraform needs before it can run.
# Everything else (APIs, runtime service accounts and their roles, budget, registry, worker
# job and key) lives in infra/terraform and is applied from main by GitHub Actions.
# Run in Cloud Shell as the project owner (and billing account administrator):
#   ./infra/bootstrap.sh dodo-512722
# Safe to re-run: every step checks whether its resource already exists.
set -euo pipefail

PROJECT="${1:?usage: bootstrap.sh PROJECT_ID}"
REPO="${DODO_GITHUB_REPO:-ArnoutVerboven/dodo}"
REGION="${DODO_REGION:-europe-west1}"
STATE_BUCKET="${PROJECT}-tfstate"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

say "Checking billing account"
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  echo "Billing is not linked to $PROJECT. Link it first, then re-run." >&2
  exit 1
fi
CURRENCY="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)')"
echo "Billing account $BILLING_ACCOUNT in $CURRENCY"
if [[ "$CURRENCY" != "EUR" ]]; then
  echo "Billing currency is $CURRENCY, not EUR: set budget_currency and budget_amount in"
  echo "infra/terraform/terraform.tfvars, and BUDGET_CURRENCY for the functions."
fi

say "Enabling the APIs Terraform needs to start"
gcloud services enable \
  serviceusage.googleapis.com cloudresourcemanager.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com storage.googleapis.com \
  cloudbilling.googleapis.com billingbudgets.googleapis.com apikeys.googleapis.com

say "Terraform state bucket gs://${STATE_BUCKET}"
gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${STATE_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning >/dev/null

ensure_sa() {
  local name="$1" display="$2"
  gcloud iam service-accounts describe "${name}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --display-name="$display"
}
# New service accounts take a little while to become visible to IAM, so retry.
retry() {
  local i
  for i in 1 2 3 4 5 6; do
    if "$@" --quiet >/dev/null 2>&1; then return 0; fi
    echo "  waiting for IAM to catch up ($i)..."
    sleep $((i * 5))
  done
  "$@" --quiet >/dev/null
}
grant() { retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" --condition=None; }
grant_billing() { retry gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" --member="serviceAccount:$1" --role="$2"; }
grant_bucket() { retry gcloud storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" --member="serviceAccount:$1" --role="$2"; }

say "Service accounts for GitHub Actions"
# deployer: deploys the app (its roles are managed by Terraform).
# terraform: applies infra/terraform from main. It manages project IAM, so it is as
#   powerful as an owner; only the terraform-apply workflow on main can use it.
# planner: read-only, plans infra/terraform on pull requests.
ensure_sa dodo-deployer "dodo deployer (GitHub Actions)"
ensure_sa dodo-terraform "dodo terraform apply (GitHub Actions, main only)"
ensure_sa dodo-planner "dodo terraform plan (GitHub Actions, read-only)"
DEPLOY_SA="dodo-deployer@${PROJECT}.iam.gserviceaccount.com"
TF_SA="dodo-terraform@${PROJECT}.iam.gserviceaccount.com"
PLAN_SA="dodo-planner@${PROJECT}.iam.gserviceaccount.com"

say "Roles for the terraform account"
for role in roles/serviceusage.serviceUsageAdmin roles/resourcemanager.projectIamAdmin \
  roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser roles/iam.workloadIdentityPoolAdmin \
  roles/pubsub.admin roles/artifactregistry.admin roles/run.admin roles/serviceusage.apiKeysAdmin; do
  grant "$TF_SA" "$role"
done
grant_billing "$TF_SA" roles/billing.costsManager   # the budget
grant_bucket "$TF_SA" roles/storage.objectAdmin

say "Roles for the planner account (read-only)"
for role in roles/viewer roles/iam.securityReviewer roles/serviceusage.apiKeysViewer \
  roles/serviceusage.serviceUsageConsumer; do
  grant "$PLAN_SA" "$role"
done
grant_billing "$PLAN_SA" roles/billing.viewer
grant_bucket "$PLAN_SA" roles/storage.objectViewer

say "Workload Identity Federation (GitHub ${REPO})"
# Tokens are accepted from main, and from the read-only plan workflow on any ref. Each
# account below is bound to one workflow by name. Keep in step with infra/terraform/wif.tf.
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow=assertion.workflow"
CONDITION="assertion.repository=='${REPO}' && (assertion.ref=='refs/heads/main' || assertion.workflow=='terraform-plan')"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
if gcloud iam workload-identity-pools providers describe github-oidc --location=global \
  --workload-identity-pool=github >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc github-oidc \
    --location=global --workload-identity-pool=github \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc github-oidc \
    --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
fi

POOL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
bind_workflow() {
  retry gcloud iam service-accounts add-iam-policy-binding "$1" \
    --role=roles/iam.workloadIdentityUser --member="${POOL}/attribute.workflow/$2"
}
bind_workflow "$DEPLOY_SA" Deploy
bind_workflow "$TF_SA" terraform-apply
bind_workflow "$PLAN_SA" terraform-plan
# Remove the repository-wide binding an earlier version of this script created: with
# PR runs now let in for planning, it would let any branch act as the deployer.
gcloud iam service-accounts remove-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser --member="${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null 2>&1 || true

say "Done. GitHub repository variables (Settings > Secrets and variables > Actions > Variables):"
echo "  GCP_PROJECT_ID   = ${PROJECT}"
echo "  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-oidc"
echo "  GCP_DEPLOYER_SA  = ${DEPLOY_SA}"
echo "  OWNER_EMAIL      = <the Google account you sign in with>"
echo
echo "Next: run the terraform-apply workflow (Actions tab) once, then the Deploy workflow."
