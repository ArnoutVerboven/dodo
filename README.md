# dodo

A personal, asynchronous AI task agent. Create a task on a board; an agent works on it in the background (in a GCP sandbox or on your Mac), keeps a top-down Summary and Status on the task, asks you only for real decisions and approvals, and never spends more than the budget you set.

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [One-time setup](docs/SETUP.md)
- [GitHub](docs/GITHUB.md): the agent clones your repos, pushes branches and opens pull requests

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
pnpm mac setup <code> ~/code    # the code is in Settings › Your Macs › Add a Mac;
                                # ~/code is a folder the agent may work in (any number)
```

`pnpm mac` installs, builds and runs the CLI in one go; `setup` pairs the Mac, adds the folders, runs the checks and keeps the daemon running in the background (launchd, starts at login). After that, `pnpm dodo status` shows whether it is online and what is queued. The steps one by one:

```sh
pnpm install && pnpm build
pnpm dodo login <code>
pnpm dodo folders add ~/code    # folders the agent may work in (none by default)
pnpm dodo doctor                # checks node, pairing, sign-in, worker build and sandbox
pnpm dodo daemon                # in the foreground; or: pnpm dodo daemon install
```

**A browser for the agent.** A task with **Browser: Yes** on it (or as a project default) gets a real Chrome window on your Mac, with nothing to install: the daemon opens its own Chrome window with its own profile under `~/.dodo/chrome`. Log in to a site there once (itsme, MFA, passkeys, all in a real visible Chrome), and the session stays for every later task. The agent gets its own tab group, opening a site is an egress decision like any other, and anything that looks like pay, order, confirm, send, delete or sign asks first. When a login needs you, do it in that window and reply to the task; the agent continues in the same session. Files it saves land in `~/.dodo/work/browser`. **Browser: Auto** attaches one only when a small model thinks the task needs it, and the agent can still ask for one mid-task. A remote run gets headless Chromium instead: nobody sees it, logins come from the vault, and when a page needs you (a code, an approval in an app) the question comes with a screenshot and the page stays open for up to 10 minutes for your answer. The logins a task makes remotely are kept (encrypted) for its next runs until the task is done. **Device: Auto** picks your Mac whenever it is online, otherwise remote.

Optional: to put the agent inside your everyday Chrome instead, with the logins you already have, add the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) (`pnpm dodo browser install` opens the page). The daemon switches to it on its own; Chrome asks you to allow the agent the first time, or `pnpm dodo browser connect <token>` with the extension's token makes it never ask. `pnpm dodo browser use window` goes back. Chrome itself cannot be driven from outside without something inside it (since Chrome 136 it refuses remote debugging on your profile), which is why the extension exists.

**MCP servers on your Mac.** Tools that live on the Mac, such as Outlook, run as local MCP servers that you add on the Mac itself: `pnpm dodo mcp add outlook -- npx -y <package>` (env values with `--env KEY=VALUE` stay in `~/.dodo/config.json`). It starts once in that terminal, so a sign-in it asks for happens there; afterwards it shows up in the web app under **Tools** with its tools, where you can switch it or single tools off, refresh it and put it in toolsets. The daemon runs it outside the sandbox, as you, and hands each run on that Mac a localhost endpoint for it. `pnpm dodo mcp test <name>` signs in again, `pnpm dodo mcp remove <name>` removes it. Remote (HTTP) MCP servers are added in the Tools view and work for every run.

Revoke a Mac in Settings; `pnpm dodo logout` forgets the pairing on the Mac itself. The device sign-in lives in the macOS Keychain; the daemon never holds model or cloud keys.

**What a task may touch on your Mac.** Each run is a separate process inside [Anthropic's sandbox runtime](https://github.com/anthropic-experimental/sandbox-runtime) (Seatbelt on macOS, bubblewrap on Linux), the same mechanism Claude Code uses:

- Files: it can read anything outside your home folder, but inside it only the folders you added with `dodo folders add` and the daemon's work folder (`~/.dodo/work`). It can write only there and in the temp folder. Your `~/.ssh`, Keychain, documents and the pairing itself stay out of reach.
- Network: only through the runtime's proxy, which allows the dodo backend, GitHub and the package registries. Any other host is checked against the task's policy (allowed hosts in Settings, allow rules, or the approval you just gave) and refused otherwise. The daemon log shows every refusal.
- The agent still asks before commands that reach the network or write outside the task folder, as it does in the cloud; the sandbox is the backstop under that.

The daemon refuses to run tasks when it cannot sandbox them (`dodo doctor` says why; on Linux install `bubblewrap socat ripgrep`). `DODO_SANDBOX=off` turns it off for development only.

## Deploy

Pushes to `main` deploy through GitHub Actions with Workload Identity Federation (no keys). The repository variables `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA` come from `infra/bootstrap.sh`.
