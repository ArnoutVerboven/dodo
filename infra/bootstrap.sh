#!/usr/bin/env bash
# One-time setup of the GCP project for dodo. Run in Cloud Shell as the project owner:
#   ./infra/bootstrap.sh dodo-512722
# Safe to re-run: every step checks whether its resource already exists.
set -euo pipefail

PROJECT="${1:?usage: bootstrap.sh PROJECT_ID}"
REPO="${DODO_GITHUB_REPO:-ArnoutVerboven/dodo}"
REGION="${DODO_REGION:-europe-west1}"
BUDGET_AMOUNT="${DODO_BUDGET:-50}"
# The cap is a lifetime total: the budget covers one long custom period instead of
# resetting every month.
BUDGET_START="${DODO_BUDGET_START:-$(date -u +%Y-%m-01)}"
BUDGET_END="${DODO_BUDGET_END:-2030-12-31}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

say "Enabling APIs"
gcloud services enable \
  firestore.googleapis.com firebase.googleapis.com firebaserules.googleapis.com \
  firebasehosting.googleapis.com identitytoolkit.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  aiplatform.googleapis.com cloudbilling.googleapis.com billingbudgets.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
  cloudscheduler.googleapis.com monitoring.googleapis.com apikeys.googleapis.com \
  fcm.googleapis.com fcmregistrations.googleapis.com

say "Checking billing account"
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  echo "Billing is not linked to $PROJECT. Link it first, then re-run." >&2
  exit 1
fi
CURRENCY="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)')"
echo "Billing account $BILLING_ACCOUNT in $CURRENCY"
if [[ "$CURRENCY" != "EUR" ]]; then
  echo "Billing currency is $CURRENCY, not EUR. Set DODO_BUDGET to the amount in $CURRENCY and"
  echo "BUDGET_CURRENCY for the functions, or ask in the project thread before continuing."
  read -r -p "Continue with a budget of ${BUDGET_AMOUNT} ${CURRENCY}? [y/N] " ok
  [[ "$ok" == "y" ]] || exit 1
fi

say "Pub/Sub topic for budget alerts"
gcloud pubsub topics describe billing-alerts >/dev/null 2>&1 || gcloud pubsub topics create billing-alerts

say "Lifetime budget of ${BUDGET_AMOUNT} ${CURRENCY} on ${PROJECT} (${BUDGET_START} to ${BUDGET_END})"
EXISTING_BUDGET="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
  --filter="displayName='dodo hard cap'" --format='value(name)' || true)"
if [[ -n "$EXISTING_BUDGET" ]]; then
  PERIOD_START="$(gcloud billing budgets describe "$EXISTING_BUDGET" \
    --format='value(budgetFilter.customPeriod.startDate.year)' || true)"
  if [[ -z "$PERIOD_START" ]]; then
    echo "Replacing the earlier monthly budget with a lifetime budget"
    gcloud billing budgets delete "$EXISTING_BUDGET" --quiet
    EXISTING_BUDGET=""
  fi
fi
if [[ -z "$EXISTING_BUDGET" ]]; then
  # Credits are excluded so the budget tracks gross cost: it fires earlier, never later.
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name="dodo hard cap" \
    --budget-amount="${BUDGET_AMOUNT}${CURRENCY}" \
    --filter-projects="projects/${PROJECT}" \
    --credit-types-treatment=exclude-all-credits \
    --start-date="$BUDGET_START" \
    --end-date="$BUDGET_END" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.8 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --notifications-rule-pubsub-topic="projects/${PROJECT}/topics/billing-alerts"
else
  echo "Budget exists: $EXISTING_BUDGET"
fi

ensure_sa() {
  local name="$1" display="$2"
  gcloud iam service-accounts describe "${name}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --display-name="$display"
}
# New service accounts take a little while to become visible to IAM, so retry.
grant() {
  local i
  for i in 1 2 3 4 5 6; do
    if gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" \
      --condition=None --quiet >/dev/null 2>&1; then
      return 0
    fi
    echo "  waiting for $1 to propagate ($i)..."
    sleep $((i * 5))
  done
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" \
    --condition=None --quiet >/dev/null
}

COMPUTE_SA_EARLY="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "Kill switch service account"
ensure_sa dodo-killswitch "dodo kill switch"
KILL_SA="dodo-killswitch@${PROJECT}.iam.gserviceaccount.com"
grant "$KILL_SA" roles/billing.projectManager   # unlink billing from this project
grant "$KILL_SA" roles/datastore.user           # set settings/global.halted
grant "$KILL_SA" roles/eventarc.eventReceiver
grant "$KILL_SA" roles/run.invoker
grant "$KILL_SA" roles/run.developer            # cancel running worker executions

say "Runtime service accounts for phase 2"
# Gateway: the only identity allowed to call Vertex AI (runs the gateway/control-plane functions).
ensure_sa dodo-gateway "dodo model gateway + control plane"
GATEWAY_SA="dodo-gateway@${PROJECT}.iam.gserviceaccount.com"
grant "$GATEWAY_SA" roles/aiplatform.user
grant "$GATEWAY_SA" roles/datastore.user
grant "$GATEWAY_SA" roles/firebaseauth.admin        # mint/revoke per-run identities
grant "$GATEWAY_SA" roles/run.developer             # start worker executions
grant "$GATEWAY_SA" roles/eventarc.eventReceiver
grant "$GATEWAY_SA" roles/run.invoker
grant "$GATEWAY_SA" roles/storage.objectAdmin        # archive run sessions and traces
# createCustomToken in Cloud Functions signs with the IAM signBlob API: the account must be
# allowed to create tokens as itself.
gcloud iam service-accounts add-iam-policy-binding "$GATEWAY_SA" --project "$PROJECT" \
  --member "serviceAccount:$GATEWAY_SA" --role roles/iam.serviceAccountTokenCreator -q >/dev/null
# Worker: deliberately NO roles. Any process in the container can read its token.
ensure_sa dodo-worker "dodo worker (no roles by design)"
WORKER_SA="dodo-worker@${PROJECT}.iam.gserviceaccount.com"

say "Service agents needed by Cloud Functions (2nd gen) deploys"
# The deployer may not change project IAM, so these must be set here, once.
grant "service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" roles/iam.serviceAccountTokenCreator
grant "$COMPUTE_SA_EARLY" roles/run.invoker
grant "$COMPUTE_SA_EARLY" roles/eventarc.eventReceiver

say "Deployer service account for GitHub Actions"
ensure_sa dodo-deployer "dodo deployer (GitHub Actions)"
DEPLOY_SA="dodo-deployer@${PROJECT}.iam.gserviceaccount.com"
for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin \
  roles/artifactregistry.admin roles/serviceusage.serviceUsageConsumer \
  roles/cloudbuild.builds.editor roles/eventarc.admin roles/pubsub.editor roles/secretmanager.viewer \
  roles/storage.admin roles/monitoring.alertPolicyEditor roles/monitoring.notificationChannelEditor \
  roles/secretmanager.admin roles/cloudscheduler.admin roles/serviceusage.apiKeysAdmin; do
  grant "$DEPLOY_SA" "$role"
done
# The deployer may act only as the runtime accounts it deploys, not as any account in the
# project (in particular not as itself or future accounts with billing rights).
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
APPSPOT_SA="${PROJECT}@appspot.gserviceaccount.com"   # Firebase CLI checks ActAs on it for functions deploys
for runtime_sa in "$KILL_SA" "$GATEWAY_SA" "$WORKER_SA" "$COMPUTE_SA" "$APPSPOT_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$runtime_sa" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser --quiet >/dev/null
done
# Remove the broader project-level binding an earlier version of this script created.
gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/iam.serviceAccountUser --condition=None --quiet >/dev/null 2>&1 || true

say "Workload Identity Federation (GitHub -> deployer, main branch of ${REPO} only)"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe github-oidc --location=global \
  --workload-identity-pool=github >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github-oidc \
    --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${REPO}' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --quiet >/dev/null

say "Done. Add these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables):"
echo "  GCP_PROJECT_ID   = ${PROJECT}"
echo "  GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github-oidc"
echo "  GCP_DEPLOYER_SA  = ${DEPLOY_SA}"
echo "  OWNER_EMAIL      = <the Google account you sign in with>"
echo
echo "The first sign-in with OWNER_EMAIL becomes the owner automatically."
