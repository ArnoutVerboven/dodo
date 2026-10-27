# dodo

A personal, asynchronous AI task agent. Create a task on a board; an agent works on it in the background (in a GCP sandbox or on your Mac), keeps a top-down Summary and Status on the task, asks you only for real decisions and approvals, and never spends more than the budget you set.

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [One-time setup](docs/SETUP.md)

## Layout

```txt
apps/web          React task board (Firebase Hosting)
apps/cli          `dodo` CLI and the Mac daemon (local executor)
apps/functions    Cloud Functions: GCP budget kill switch (more in phase 2)
packages/core     domain model (zod), shared by everything
packages/budget   CostGate: reserve -> execute -> settle, pricing, Firestore store
tests/rules       Firestore security rules tests
infra/            one-time GCP bootstrap (budget, kill switch, keyless deploys)
scripts/          local emulator seed data
```

## Develop locally

Needs Node 22, pnpm (`corepack enable`), and Java 21 for the Firebase emulators.

```sh
pnpm install
pnpm emulators            # terminal 1: local Auth, Firestore, Storage
pnpm seed                 # terminal 2: owner account + example data
pnpm dev                  # web app on http://localhost:5173, "Sign in as local owner"
```

Checks (same as CI):

```sh
pnpm lint
pnpm build
pnpm test:emulator        # unit, Firestore budget store and security rules tests
```

## Run tasks on your Mac

A task whose device is your Mac is picked up by a small daemon on it; the agent then works in the folders you allow, with model calls still going through the gateway and the same approvals. Needs Node 22 and pnpm.

```sh
git clone https://github.com/ArnoutVerboven/dodo && cd dodo
pnpm install && pnpm build
pnpm dodo login <code>          # the code is in Settings › Your Macs › Add a Mac
pnpm dodo folders add ~/code    # folders the agent may work in (none by default)
pnpm dodo daemon                # or: pnpm dodo daemon install  (launchd, starts at login)
pnpm dodo status                # online? queued runs? log location
```

`pnpm dodo doctor` checks the setup. Revoke a Mac in Settings; `pnpm dodo logout` forgets the pairing on the Mac itself. The device sign-in lives in the macOS Keychain; the daemon never holds model or cloud keys.

**What a task may touch on your Mac.** Each run is a separate process inside [Anthropic's sandbox runtime](https://github.com/anthropic-experimental/sandbox-runtime) (Seatbelt on macOS, bubblewrap on Linux), the same mechanism Claude Code uses:

- Files: it can read anything outside your home folder, but inside it only the folders you added with `dodo folders add` and the daemon's work folder (`~/.dodo/work`). It can write only there and in the temp folder. Your `~/.ssh`, Keychain, documents and the pairing itself stay out of reach.
- Network: only through the runtime's proxy, which allows the dodo backend, GitHub and the package registries. Any other host is checked against the task's policy (allowed hosts in Settings, allow rules, or the approval you just gave) and refused otherwise. The daemon log shows every refusal.
- The agent still asks before commands that reach the network or write outside the task folder, as it does in the cloud; the sandbox is the backstop under that.

The daemon refuses to run tasks when it cannot sandbox them (`dodo doctor` says why; on Linux install `bubblewrap socat ripgrep`). `DODO_SANDBOX=off` turns it off for development only.

## Deploy

Pushes to `main` deploy through GitHub Actions with Workload Identity Federation (no keys). The repository variables `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA` come from `infra/bootstrap.sh`.
