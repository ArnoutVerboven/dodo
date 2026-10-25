# dodo — One-time setup (what you do by hand)

Everything else is scripted in `infra/` and deployed from GitHub Actions. No service account keys are created.

## 1. Firebase (about 5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** → choose the **existing** Google Cloud project `dodo-512722`. Keeping Firebase and GCP in one project means one bill and one budget cap.
2. Plan: it will show **Blaze** because billing is already linked. That is fine: the free tier still applies, and Blaze is needed for Functions and Storage.
3. Skip Google Analytics.
4. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
5. **Build → Firestore Database → Create database** → *Production mode* → location **`europe-west1`** (or tell me another region before you do this: it cannot be changed later).
6. **Build → Storage → Get started** → same location.
7. **Project settings → General → Your apps → Web (`</>`)** → nickname `dodo-web`, tick **Firebase Hosting** → Register. Copy the `firebaseConfig` object and paste it in the thread (it is not secret).

## 2. GCP access for deployments (about 10 minutes)

Run the bootstrap script once in **Cloud Shell** (<https://shell.cloud.google.com>, logged in as the project owner) when phase 1 lands:

```sh
git clone https://github.com/ArnoutVerboven/dodo && cd dodo
./infra/bootstrap.sh dodo-512722
```

It will:

- enable the needed APIs (Firestore, Cloud Run, Cloud Functions, Pub/Sub, Vertex AI, Billing Budgets, Artifact Registry, IAM Credentials);
- create the **50 EUR budget** with Pub/Sub alerts and the kill-switch service account (needs you to be *Billing Account Administrator* on the billing account, which you are if you created it);
- set low quotas (Cloud Run concurrency, Vertex AI tokens per minute);
- create a `dodo-deployer` service account and a **Workload Identity Federation** pool that trusts only GitHub Actions runs from `ArnoutVerboven/dodo` on `main`.

Then add two GitHub repo variables (Settings → Secrets and variables → Actions → *Variables*), printed at the end of the script: `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA`.

What I need from you, in short:

- [ ] Firebase steps above, and the `firebaseConfig` in the thread.
- [ ] The bootstrap script run once, and the two repo variables set.
- [ ] Your billing account currency (EUR?), so budget amounts are exact.

## 3. Later phases

- **Mac**: Node 22 (`brew install node`), then the `dodo` CLI (phase 4).
- **Credentials**: a dedicated vault in your password manager for agent use (phase 5).
