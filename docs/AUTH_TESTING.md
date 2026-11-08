# Auth testing: logins on your Mac and remotely

dodo's agent logs in to sites for you in two places: on your Mac, in the dodo Chrome window, and remotely, in a headless Chromium in Cloud Run. Whether a login works there depends on the site, the login method and the second factor, and none of that can be faked in CI. So there is a manual test that logs in for real, through ordinary dodo tasks, and writes down what works where: [AUTH_MATRIX.md](AUTH_MATRIX.md).

## Run it

The test always uses the same four logins, fixed in [`tests/auth/src/sites.ts`](../tests/auth/src/sites.ts):

| Id          | Login                                                                                                                        | Vault entry it uses (by its site)                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `itsme`     | itsme on [engie.be](https://www.engie.be/nl/login/): a QR code you scan off the Mac screen; the remote case moves to the Mac | optional: `engie.be` (else `itsme-id.com`)                                                    |
| `google`    | "Continue with Google" on [vinted.com](https://www.vinted.com/)                                                              | `google.com`                                                                                  |
| `password`  | username + password on [overleaf.com](https://www.overleaf.com/login)                                                        | `overleaf.com`                                                                                |
| `email-2fa` | email, then a code by mail, on [booking.com](https://account.booking.com/sign-in)                                            | optional: by default your email address from your personal info, then the code from your mail |

`google-session` (your stored Google session, remotely) is there too, but only runs with `--only google-session`.

Before the first run, make sure those vault entries exist ([Settings › Vault](https://dodo-app.web.app/settings)). The test finds each one by its site, so the names do not matter. Then, on your Mac:

```sh
git pull && pnpm install
pnpm test:auth
```

If it can't reach your dodo data, it offers to run `gcloud auth application-default login`, which signs you in through the browser. Then it shows which vault entry each login uses (and warns about a missing one), the plan and the expected cost, and asks before it starts.

```sh
pnpm test:auth cost                         # free: what a run will cost, and what auth tests cost this month
pnpm test:auth --dry-run                    # free: the plan, the exact task texts and the expected cost
pnpm test:auth --only google --env remote   # one cell of the matrix
pnpm test:auth --only email-2fa             # one login, on the Mac and remotely
pnpm test:auth --help                       # all options
```

**Cost.** Before it starts, the test shows the expected cost of every case: the cost that case had last time, or a rough guess (about €0.10 on the Mac, €0.15 remotely) until it has run once. It also shows the hard limit (€0.40 per case by default) and what the auth tests have cost so far this month, against the project's €5 monthly cap. After each case it prints what that case cost, split into model calls and Cloud Run time, and at the end the total for the run next to what was expected. The costs also go into the overview.

Have your phone at hand. After the one "Start?" (skip it with `-y`), the test starts every case at once and you type nothing more in the terminal: remote cases run side by side, and local cases queue on your Mac, which runs one task at a time. When the agent needs you (an itsme push, a Google prompt, a code), you answer in dodo, in the app or on Telegram, as you would for any task. That way the test covers the real MFA path too. The terminal prints what each case does, tagged with its id. When a case ends, the test closes its task, which also drops the task's stored logins and codes. The agent's own result line counts; with `--ask` the test asks you afterwards, per case, whether that claim is right and whether you had to touch the Mac itself.

The agent starts every login signed out: if a site already shows you signed in, it signs out and checks for the login form first, and reports `failed | could not sign out first` when it cannot (so an old session never passes as a working login). `--reuse-sessions` turns this off.

At the end it prints the overview, saves the raw results in `tests/auth/results/` (gitignored), and updates [AUTH_MATRIX.md](AUTH_MATRIX.md) and `docs/auth-matrix.json` with the latest result of every case it ran. Commit those two files to keep the overview current. A run with `--only` updates only its own cells.

## What a case is

Each case is a normal dodo task in the project "Auth tests", tagged `auth-test`:

- **Device** pinned: your Mac (`mac:<id>`) for local, `gcp` for remote. **Browser** always on.
- **Grants up front**, so the only things you get asked are the login itself: the method's vault entry (`Vault(<id>)`), the hosts it passes through (allowed hosts, and `Browser(submit:<host>)` so "Next" or Enter in a password field does not ask), and `GoogleSession(use)` only for the stored-session case.
- **Instructions**: log in and nothing else; sign out first when already signed in (unless `--reuse-sessions`); for Google remotely, sign in fresh instead of using your stored Google session; end with one line in the Summary, `AUTH_RESULT: ok | <proof>` or `AUTH_RESULT: failed | <why>`.
- **Budget**: €0.40 per case by default (`--budget`), and the project has a €5 monthly cap (`--month-cap`). A case that runs out stops like any task.

The result of a case comes from the agent's line, what you confirmed, and what the task shows afterwards: which devices the runs used (a remote case that moved to the Mac counts as "works after moving"), how many questions, codes and screenshots it took, whether a question sent you to the Mac's own screen, how long it took and what it cost.

## When to run it

It is not free and it needs you, so it is on demand only. It is not part of CI or of any commit hook. Good moments:

- after changing anything on the login path: the browser tools, the headless browser (`apps/worker/src/headless.ts`, `Dockerfile.browser`), the vault, secret answers, email codes, `request_device`, or the browser prompts;
- after a Playwright, Chromium or Chrome upgrade;
- before relying on a new site or login method: add it to `sites.ts` and run `--only <id>`;
- every month or so, because sites change their logins without telling anyone.

The Mac cases run on your local model, which costs nothing unless the agent uses a paid tool such as `web_search` (the task tells it not to; the test prints what each case's cost went to); pick another with `--mac-model <id>`. The remote cases run on Gemini 3.5 Flash-Lite, to keep them cheap; pick another with `--remote-model <id>`. The local model exists only on your Mac, so a remote case never uses it. Remote cases add Cloud Run time for the browser worker.

## Fallback when a login fails remotely

When the agent cannot finish a login in the cloud browser (a passkey, a login bound to your device, a site that refuses the cloud browser, or one that still fails after a fresh try), it calls `request_device` instead of giving up. What happens next depends on the task's device setting:

| Device setting  | What happens                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto            | The task moves to your Mac at once and continues in its Chrome window, with the conversation so far. If the Mac is offline, the task says it is waiting for it and you get a notification.                                                                                                                          |
| Remote (pinned) | You get a card: "This task is set to run remotely, but the cloud browser could not finish a login. Continue it on your Mac instead?" Yes moves it; No lets the agent continue remotely with that answer. **Always allow** adds `Device(mac)` for the task, the project or everywhere, so later moves skip the card. |
| Your Mac        | Already there; no fallback is needed.                                                                                                                                                                                                                                                                               |
| No Mac paired   | The task stops with a message saying to pair one.                                                                                                                                                                                                                                                                   |

A deny rule `Device(mac)` (or `Device`) keeps a task off the Mac; the task then stops and says so. There is no fallback the other way (Mac to remote): the Mac's real Chrome is the stronger place to log in, and a remote browser cannot use the sessions in your Mac's profile.

## When you have to be at the Mac

Most logins on the Mac need only your phone: the agent types from the vault, a Google prompt goes to your phone, and a code is answered in dodo. You do need to be at the Mac itself when:

- a login uses itsme or another phone-app QR code: the code changes every few seconds, so dodo does not send it as a picture; it asks you to open the dodo Chrome window and scan the code there. In the cloud browser nobody can scan it, so such a login moves to the Mac (`request_device`);
- a site asks for a passkey, Touch ID or a security key (macOS shows its own dialog, which the agent cannot click);
- a CAPTCHA keeps coming back, or the agent asks you to "log in in the dodo Chrome window" (it does this for logins without a vault entry);
- the first time the Playwright extension connects to your everyday Chrome (Chrome asks you to allow it), if you use it.

With `--ask` the test asks you about this for every local case; it always counts the questions that sent you to the Mac's screen, so the overview shows which logins need you there.
