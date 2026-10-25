# dodo — One-time setup (what you do by hand)

Everything else is scripted in `infra/` and deployed from GitHub Actions. No service account keys are created.

## 1. Firebase (about 5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** → choose the **existing** Google Cloud project `dodo-512722`. Keeping Firebase and GCP in one project means one bill and one budget cap.
2. Plan: it will show **Blaze** because billing is already linked. That is fine: the free tier still applies, and Blaze is needed for Functions and Storage.
3. Skip Google Analytics.
4. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
5. **Build → Firestore Database → Create database** → _Production mode_ → location **`europe-west1`** (or tell me another region before you do this: it cannot be changed later).
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
- create the **50 EUR lifetime budget** (from setup to the end of 2030) with Pub/Sub alerts, and the kill-switch service account (needs you to be _Billing Account Administrator_ on the billing account, which you are if you created it);
- create a `dodo-deployer` service account and a **Workload Identity Federation** pool that trusts only GitHub Actions runs from `ArnoutVerboven/dodo` on `main`. The deployer may act only as the specific runtime accounts.

Then add the GitHub repo variables (Settings → Secrets and variables → Actions → _Variables_) printed at the end of the script: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, plus `OWNER_EMAIL` (the Google account you sign in with; the first sign-in with that email becomes the owner, nothing to run by hand).

After the first deploy, restrict the web API key in [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=dodo-512722): edit "Browser key (auto created by Firebase)" → Application restrictions → Websites → add `dodo-512722.web.app`, `dodo-512722.firebaseapp.com` and `localhost`. The key is public by design; this stops it being used from other sites.

What I need from you, in short:

- [ ] Firebase steps above, and the `firebaseConfig` in the thread.
- [ ] The bootstrap script run once, and the two repo variables set.
- [ ] Once the first deploy is live: run `./infra/test-kill-switch.sh dodo-512722` once. It sends a fake 46 EUR alert, checks that billing really got detached, and re-links it. This proves the kill switch works before any agent can spend money.

## 3. Later phases

- **Mac**: Node 22 (`brew install node`), then the `dodo` CLI (phase 4).
- **Credentials**: a dedicated vault in your password manager for agent use (phase 5).
