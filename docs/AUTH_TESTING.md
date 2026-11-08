# Auth testing: logins on your Mac and remotely

dodo's agent logs in to sites for you in two places: on your Mac, in the dodo Chrome window, and remotely, in a headless Chromium in Cloud Run. Whether a login works there depends on the site, the login method and the second factor, and none of that can be faked in CI. So there is a manual test that logs in for real, through ordinary dodo tasks, and writes down what works where: [AUTH_MATRIX.md](AUTH_MATRIX.md).

## Run it

The test always uses the same four logins, fixed in [`tests/auth/src/sites.ts`](../tests/auth/src/sites.ts):

| Id          | Login                                                                        | Vault entry it uses (by its site)                                                                   |
| ----------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `itsme`     | itsme on [engie.be](https://www.engie.be/nl/login/)                          | `engie.be` (else `itsme-id.com`); none is fine, the phone number then comes from your personal info |
| `google`    | "Continue with Google" on [booking.com](https://account.booking.com/sign-in) | `google.com`                                                                                        |
| `password`  | username + password on [overleaf.com](https://www.overleaf.com/login)        | `overleaf.com`                                                                                      |
| `email-2fa` | email + password, then a code, on [vinted.com](https://www.vinted.com/)      | `vinted.com` or `vinted.be`                                                                         |

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

Have your phone at hand. The test runs one case at a time and prints what happens. When the agent needs you (an itsme push, a Google prompt, a code), you answer in dodo, in the app or on Telegram, as you would for any task. That way the test covers the real MFA path too. After each case it asks you three short things: whether the agent's "signed in" claim is right, whether you had to do anything on the Mac itself, and any notes. Then it closes the test task, which also drops the task's stored logins and codes.

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

Local cases cost only model calls (a few cents). Point them at your local model with `--model <name>` to make them free, though small local models may not get through a login. Remote cases add Cloud Run time for the browser worker.

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

Most logins on the Mac need only your phone: the agent types from the vault, an itsme push or a Google prompt goes to your phone, and a code is answered in dodo. You do need to touch the Mac itself when:

- a login only offers a QR code and you are not answering from another screen than the phone that has the app: scan it off the Mac's screen;
- a site asks for a passkey, Touch ID or a security key (macOS shows its own dialog, which the agent cannot click);
- a CAPTCHA keeps coming back, or the agent asks you to "log in in the dodo Chrome window" (it does this for logins without a vault entry);
- the first time the Playwright extension connects to your everyday Chrome (Chrome asks you to allow it), if you use it.

The test asks you about this after every local case, and counts the questions that sent you to the Mac's screen, so the overview shows which logins need you there.
