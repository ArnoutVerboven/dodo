# Testing and test gates

Three layers, each cheaper and faster than the next one up. What a layer runs, the layer above runs again, so skipping a local hook never lets anything onto `main`.

| Layer                                   | When                        | What runs                                                                                                      | Time    | Cost                  |
| --------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| **pre-commit** hook                     | every `git commit`          | biome lint + format check on the staged files                                                                  | < 1 s   | free                  |
| **pre-push** hook (`pnpm check`)        | every `git push`            | lint, build the packages, type-check every workspace, unit tests                                               | ~40 s   | free                  |
| **CI** (`CI / gate`, required)          | every PR and push to `main` | everything above + full build, emulator tests, security rules tests, e2e on the emulators, deploy filter check | ~3 min  | free (GitHub minutes) |
| **Manual** (`pnpm test:manual <suite>`) | on demand, see below        | suites that cost money, need a phone or a visible browser, or hit production                                   | varies  | model / infra         |
| **Weekly** (`Dependency audit`)         | Monday morning, or by hand  | `pnpm audit --prod --audit-level high`                                                                         | < 1 min | free                  |

## Local, while you work

The hooks install themselves on `pnpm install` (they live in [`.githooks`](../.githooks); `scripts/install-hooks.mjs` points git at them, never in CI).

```sh
pnpm check          # the pre-push gate by hand: lint, build:libs, typecheck, unit tests
pnpm lint:fix       # fix formatting and safe lint issues
pnpm check:full     # exactly what CI runs (needs Java 21 for the emulators)
```

Skip a hook once with `git commit --no-verify` / `git push --no-verify`, or for a whole shell with `DODO_SKIP_HOOKS=1`. Opt out of installing them with `DODO_NO_HOOKS=1 pnpm install` (or `git config --unset core.hooksPath`).

Tests in `pnpm test` (and so in the pre-push hook) must be free and offline: no network, no production, no real model. Files named `*.emulator.test.ts` and `tests/rules` skip themselves unless `FIRESTORE_EMULATOR_HOST` is set, which `pnpm test:emulator` does.

## CI: what has to pass before a merge

[`ci.yml`](../.github/workflows/ci.yml) runs two jobs in parallel and one that sums them up:

- **Lint and type-check**: `biome ci`, `pnpm build`, `pnpm typecheck` (the CLI, functions and worker are bundled with esbuild, which does not check types, so this is the only place their types are checked), and `scripts/check-deploy-filters.mjs`.
- **Unit, emulator and e2e tests**: `pnpm test:emulator` (unit tests, Firestore emulator tests, security rules tests) and `pnpm test:e2e` (a task end to end on the emulators with the fake model, plus the Mac daemon sandbox under bubblewrap).
- **gate**: passes only when both passed. **This is the one check to mark as required**, so adding a job later needs no settings change.

`terraform-plan` runs only on PRs that touch `infra/terraform`; it is informative, not required (a path-filtered workflow cannot be a required check). Pushes to `main` deploy after `gate` passes.

### Turning on the gate (one-time, on GitHub)

Settings › Rules › Rulesets › New branch ruleset, target `main`:

- **Require a pull request before merging** (approvals: 0 is fine for a solo repo).
- **Require status checks to pass** → add `gate` (from GitHub Actions), and tick **Require branches to be up to date**.
- **Block force pushes**.

## Manual suites: costly, interactive, or against production

Listed in [`tests/manual/suites.mjs`](../tests/manual/suites.mjs). `pnpm test:manual` prints them with their cost, where they can run and when to run them.

```sh
pnpm test:manual            # list
pnpm test:manual auth       # run one; asks first when it costs money
```

From GitHub: **Actions › Manual tests › Run workflow** (or `gh workflow run manual-tests.yml -f suite=e2e`). Suites that need your Mac, a phone or a person during the run refuse to run there and say so. Secrets for CI-capable suites go in the `manual-tests` environment; add a required reviewer to it if a suite should wait for approval before spending money.

Each run writes its log to `tests/manual/reports/` (not committed). A suite can write a Markdown report there too (`$DODO_MANUAL_REPORT_DIR`); the workflow adds `*.md` reports to the run summary.

| Suite  | Runs                            | Cost          | Run it when                                                                                                                                                                                   |
| ------ | ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth` | your Mac only, needs your phone | model + infra | after changing browser, login, vault, MFA or device-routing code; after a Playwright or Chromium upgrade; before relying on a new site login; monthly. See [AUTH_TESTING.md](AUTH_TESTING.md) |
| `e2e`  | Mac or CI                       | free          | any time, to re-run the CI end-to-end on its own                                                                                                                                              |

### Adding a suite

1. Put the suite in its own workspace package under `tests/<name>` with a root script, e.g. `"test:auth": "pnpm --filter @dodo/auth-tests start"`.
2. Add an entry to `tests/manual/suites.mjs` (`where`, `cost`, `interactive`, `env`, `when`).
3. Keep its pure logic (parsing, classification, report rendering) in normal `*.test.ts` files: they then run in `pnpm test` and CI for free, while the costly part stays manual.
4. Give the package a `typecheck` script so the CI type-check covers it.
