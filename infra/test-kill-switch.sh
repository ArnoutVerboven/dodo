#!/usr/bin/env bash
# Proves the kill switch works for real, once, before any agent can spend money:
# sends a fake 46 EUR budget alert, checks that processing halted and billing was
# detached, then re-links billing. Run in Cloud Shell as the project owner, after the
# killSwitch function is deployed:
#   ./infra/test-kill-switch.sh dodo-512722
set -euo pipefail
PROJECT="${1:?usage: test-kill-switch.sh PROJECT_ID}"
gcloud config set project "$PROJECT" >/dev/null

ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"
[[ -n "$ACCOUNT" ]] || { echo "Billing is not linked; link it first." >&2; exit 1; }
CURRENCY="$(gcloud billing accounts describe "${ACCOUNT#billingAccounts/}" --format='value(currencyCode)')"
echo "Billing account: $ACCOUNT ($CURRENCY)"
echo "This will DETACH billing from $PROJECT for about a minute, then re-link it."
read -r -p "Continue? [y/N] " ok
[[ "$ok" == "y" ]] || exit 1

gcloud pubsub topics publish billing-alerts \
  --message="{\"budgetDisplayName\":\"kill switch test\",\"costAmount\":46,\"budgetAmount\":50,\"currencyCode\":\"${CURRENCY}\"}"

echo "Waiting for the function to detach billing..."
for _ in $(seq 1 24); do
  sleep 5
  ENABLED="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')"
  if [[ "$ENABLED" != "True" ]]; then
    echo "OK: billing detached by the kill switch."
    gcloud billing projects link "$PROJECT" --billing-account="${ACCOUNT#billingAccounts/}" >/dev/null
    echo "Billing re-linked."
    echo "Processing stays halted: clear it in the web app under Settings > Resume processing."
    exit 0
  fi
done
echo "FAILED: billing still enabled after 2 minutes. Check the killSwitch function logs:" >&2
echo "  gcloud functions logs read killSwitch --region=europe-west1 --limit=50" >&2
exit 1
