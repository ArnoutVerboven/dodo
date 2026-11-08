// Manually triggered test suites: too slow, costly, or interactive for the merge gate.
// Run one with `pnpm test:manual <name>` (locally) or the "Manual tests" workflow (GitHub
// Actions › Manual tests › Run workflow). `pnpm test:manual` alone lists them.
// See docs/TESTING.md for when to run which.
//
// Adding a suite: add an entry here and a root package.json script it runs. Fields:
//   name         what you type: `pnpm test:manual <name>`
//   description  one line, shown in the list
//   command      the shell command that runs it (from the repo root)
//   where        'local' (needs your Mac, a phone, a visible browser...) and/or 'ci'
//   cost         'free' | 'model' (LLM tokens) | 'infra' (Cloud Run, etc.); a list
//   interactive  true when someone has to act during the run (MFA on a phone, a QR scan)
//   env          variables that must be set before it starts
//   when         when to run it (shown in the list and in docs/TESTING.md)

/** @type {Array<{name: string, description: string, command: string, where: Array<'local'|'ci'>, cost: Array<'free'|'model'|'infra'>, interactive: boolean, env?: string[], when: string}>} */
export const suites = [
  {
    name: 'auth',
    description:
      'Login matrix against production: itsme (engie.be), Google (vinted), username+password (overleaf) and email+2FA (booking.com), on the Mac and remote, with MFA on your phone (pnpm test:auth --help for one method or device)',
    command: 'pnpm test:auth',
    where: ['local'],
    cost: ['model', 'infra'],
    interactive: true,
    when: 'After changing browser, login, vault, MFA or device-routing code; after a Playwright or Chromium upgrade; before relying on a new site login; monthly, as sites change',
  },
  {
    name: 'e2e',
    description: 'End-to-end on the Firebase emulators with the fake model (also part of CI)',
    command: 'pnpm build && pnpm test:e2e',
    where: ['local', 'ci'],
    cost: ['free'],
    interactive: false,
    when: 'Any time; handy to re-run CI e2e on its own',
  },
];
