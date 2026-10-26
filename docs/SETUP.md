# dodo — One-time setup (what you do by hand)

Everything else is in `infra/` (Terraform for GCP) and deployed from GitHub Actions. No service account keys are created.

## 1. Firebase (about 5 minutes)

1. Go to <https://console.firebase.google.com> → **Add project** → choose the **existing** Google Cloud project `dodo-512722`. Keeping Firebase and GCP in one project means one bill and one budget cap.
2. Plan: it will show **Blaze** because billing is already linked. That is fine: the free tier still applies, and Blaze is needed for Functions and Storage.
3. Skip Google Analytics.
4. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
5. **Build → Firestore Database → Create database** → _Production mode_ → location **`europe-west1`** (or tell me another region before you do this: it cannot be changed later).
6. **Build → Storage → Get started** → same location.
7. **Project settings → General → Your apps → Web (`</>`)** → nickname `dodo-web`, tick **Firebase Hosting** → Register. Copy the `firebaseConfig` object and paste it in the thread (it is not secret).

## 2. GCP access for deployments (about 10 minutes)

The GCP side is Terraform in [`infra/terraform`](../infra/terraform), planned on every PR and applied from `main` by GitHub Actions. Run the bootstrap script once in **Cloud Shell** (<https://shell.cloud.google.com>, logged in as the project owner) for the few things Terraform needs before it can run:

```sh
git clone https://github.com/ArnoutVerboven/dodo && cd dodo
./infra/bootstrap.sh dodo-512722
```

It will:

- check that billing is linked and enable the handful of APIs Terraform itself needs;
- create the Terraform state bucket `gs://dodo-512722-tfstate`;
- create three service accounts for GitHub Actions: `dodo-deployer` (deploys the app), `dodo-terraform` (applies Terraform; it manages IAM, so it is as powerful as an owner) and `dodo-planner` (read-only, plans PRs). The last two need you to be _Billing Account Administrator_ on the billing account, which you are if you created it;
- set up a **Workload Identity Federation** pool that trusts only GitHub Actions runs from `ArnoutVerboven/dodo`: on `main`, plus the read-only `terraform-plan` workflow on PRs. Each account is bound to one workflow by name (`Deploy`, `terraform-apply`, `terraform-plan`). No service account keys are created.

Then add the GitHub repo variables (Settings → Secrets and variables → Actions → _Variables_) printed at the end of the script: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, plus `OWNER_EMAIL` (the Google account you sign in with; the first sign-in with that email becomes the owner, nothing to run by hand).

On a new project, run the **terraform-apply** workflow once (Actions tab → terraform-apply → Run workflow) before the first Deploy. It enables the APIs and creates the runtime service accounts and roles, the **50 EUR lifetime budget** (from setup to the end of 2030) with Pub/Sub alerts for the kill switch, the Artifact Registry repo, the worker Cloud Run Job and its API key. After that it runs by itself whenever `infra/terraform` changes on `main`.

After the first deploy, restrict the web API key in [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=dodo-512722): edit "Browser key (auto created by Firebase)" → Application restrictions → Websites → add `dodo-tasks.web.app`, `dodo-512722.web.app`, `dodo-512722.firebaseapp.com` and `localhost`. The key is public by design; this stops it being used from other sites. The worker on Cloud Run uses its own key (`dodo-worker`, restricted by API, managed by Terraform), so the website restriction does not affect it. Ignore the console's warning about Static Maps; dodo does not use it.

The app is served at <https://dodo-tasks.web.app>, a second Firebase Hosting site the deploy workflow creates; the project's default site (`dodo-512722.web.app`) only redirects there (`firebase.json`). Google sign-in runs through that same domain (`VITE_FIREBASE_AUTH_DOMAIN=dodo-tasks.web.app`), so browsers that partition third-party storage don't lose the sign-in state. For that to work:

- In the same Credentials page, edit "Web client (auto created by Google Service)": add `https://dodo-tasks.web.app/__/auth/handler` under Authorized redirect URIs and `https://dodo-tasks.web.app` under Authorized JavaScript origins. Without it, Google shows `redirect_uri_mismatch` on sign-in.
- In Firebase Console → Authentication → Settings → Authorized domains, make sure `dodo-tasks.web.app` is listed.

What I need from you, in short:

- [ ] Firebase steps above, and the `firebaseConfig` in the thread.
- [ ] The bootstrap script run once, the repo variables set, and terraform-apply run once.
- [ ] Once the first deploy is live: run `./infra/test-kill-switch.sh dodo-512722` once. It sends a fake 46 EUR alert, checks that billing really got detached, and re-links it. This proves the kill switch works before any agent can spend money.

## 3. Later phases

- **Mac**: Node 22 (`brew install node`), then the `dodo` CLI (phase 4).
- **Credentials**: a dedicated vault in your password manager for agent use (phase 5).
