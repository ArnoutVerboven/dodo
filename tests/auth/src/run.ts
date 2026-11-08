/**
 * Manual auth test: logs in with each fixed login in sites.ts (itsme on engie.be, Google on
 * booking.com, a password on overleaf, email + 2FA on vinted) on your Mac and remotely, through
 * real dodo tasks, and writes down what works where.
 *
 *   pnpm test:auth                         # runs every case
 *   pnpm test:auth cost                    # what a run will cost, and what auth tests cost so far
 *   pnpm test:auth --only itsme --env remote
 *   pnpm test:auth --dry-run               # the plan and the task texts, nothing created
 *
 * It costs money (model calls; Cloud Run for remote cases) and needs you: you approve logins on
 * your phone and answer the agent's questions in dodo, as you normally would. So it never runs
 * in CI. See docs/AUTH_TESTING.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import {
  buildCases,
  type Case,
  type CaseResult,
  caseState,
  classify,
  costBreakdown,
  type Env,
  estimateCost,
  euro,
  mergeResults,
  type Observation,
  parseTargets,
  RESULT_LINE,
  renderReport,
  replaceMatrix,
  resolveVault,
  type TesterAnswers,
  taskDescription,
  taskDoc,
  type VaultSummary,
} from './matrix.ts';
import { SITES } from './sites.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const APP_URL = 'https://dodo-app.web.app';
const PROJECT_ID = 'auth-tests';
const HEARTBEAT_MS = 30_000;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: 'string' },
    env: { type: 'string' },
    targets: { type: 'string' },
    mac: { type: 'string' },
    model: { type: 'string' },
    budget: { type: 'string', default: '0.40' },
    'month-cap': { type: 'string', default: '5' },
    timeout: { type: 'string', default: '15' },
    'reuse-sessions': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    ask: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    project: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`pnpm test:auth [cost] [options]

  (nothing)             run the test: ${SITES.methods
    .filter((m) => m.enabled !== false)
    .map((m) => m.label)
    .join(', ')}
  cost                  what a run will cost, and what the auth tests cost this month (free)

  --only itsme,google   methods to test: ${SITES.methods.map((m) => m.id).join(', ')}
                        default: all but google-session
  --env local,remote    where to test; default: both
  --targets <file>      test other sites: a JSON file shaped like tests/auth/src/sites.ts
  --mac <id|name>       the Mac for local cases; default: the one seen most recently
  --model <id>          model for the agent; default: your usual one on the Mac, dodo's default
                        Gemini remotely (the local model cannot run remotely)
  --budget 0.40         budget cap per case in EUR
  --month-cap 5         monthly cap of the "Auth tests" project in EUR
  --timeout 15          minutes before a case counts as timed out
  --reuse-sessions      keep existing logins instead of signing out first
  --keep                leave the test tasks open instead of closing them
  --ask                 after the run, ask per case whether the agent was right and whether
                        you had to touch the Mac (otherwise the agent's own result counts)
  --dry-run             print the plan and the task texts; create nothing
  -y, --yes             do not ask before starting
  --project <id>        Firebase project; default from apps/web/.env.production`);
  process.exit(0);
}

const list = (v?: string) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const envs = list(args.env) as Env[];
for (const e of envs) if (e !== 'local' && e !== 'remote') fail(`--env: local or remote, not ${e}`);
const budgetEur = Number(args.budget);
const monthCapEur = Number(args['month-cap']);
const timeoutMs = Number(args.timeout) * 60_000;
if (!(budgetEur > 0) || !(monthCapEur > 0) || !(timeoutMs > 0))
  fail('budget, cap and timeout must be > 0');

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const command = positionals[0];
if (command && command !== 'cost') fail(`Unknown command "${command}"`);
const targets = args.targets
  ? parseTargets(JSON.parse(readFileSync(path.resolve(args.targets), 'utf8')))
  : parseTargets(SITES);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();
const yesNo = async (q: string, def?: boolean): Promise<boolean | undefined> => {
  const hint = def === undefined ? 'y/n/enter to skip' : def ? 'Y/n' : 'y/N';
  const a = (await ask(`${q} [${hint}] `)).toLowerCase();
  if (!a) return def;
  return /^y/.test(a);
};

const storePath = path.join(root, 'docs/auth-matrix.json');
const history = (): CaseResult[] =>
  existsSync(storePath) ? (JSON.parse(readFileSync(storePath, 'utf8')) as CaseResult[]) : [];

function printEstimate(cs: Case[]) {
  const est = estimateCost(cs, history(), budgetEur);
  console.log('\nExpected cost:');
  for (const r of est.cases) {
    console.log(
      `  ${r.id.padEnd(24)} ${euro(r.eur)}  ${r.measured ? '(last run)' : '(rough guess)'}`,
    );
  }
  console.log(
    `  ${'total'.padEnd(24)} ${euro(est.total)}  (never more than ${euro(est.cap)}: ${euro(budgetEur)} cap per case)`,
  );
}

if (args['dry-run']) {
  const cs = buildCases(targets, { only: list(args.only), envs });
  console.log(`Plan: ${cs.length} case${cs.length === 1 ? '' : 's'}\n`);
  for (const c of cs) {
    console.log(
      `── ${c.id} ──\n${taskDescription(c, { reuseSessions: args['reuse-sessions'] })}\n`,
    );
  }
  printEstimate(cs);
  process.exit(0);
}

// ── Connect ─────────────────────────────────────────────────────────────────

function projectId(): string {
  if (args.project) return args.project;
  const env = readFileSync(path.join(root, 'apps/web/.env.production'), 'utf8');
  const id = /^VITE_FIREBASE_PROJECT_ID=(.+)$/m.exec(env)?.[1]?.trim();
  if (!id) fail('No project id: pass --project');
  return id;
}

initializeApp({ projectId: projectId(), credential: applicationDefault() });
const db: Firestore = getFirestore();

/** Reads Firestore once; when that fails for want of a sign-in, offers to run gcloud. */
async function connect(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await db.doc('settings/global').get()).data() ?? {};
    } catch (err) {
      console.log(`\nCannot reach your dodo data (${String(err).split('\n')[0]}).`);
      if (attempt > 0) break;
      if (!(await yesNo('Sign in with gcloud now (opens your browser)?', true))) break;
      const r = spawnSync('gcloud', ['auth', 'application-default', 'login'], { stdio: 'inherit' });
      if (r.error) {
        fail(
          'gcloud is not installed. Install it (https://cloud.google.com/sdk/docs/install), then run pnpm test:auth again.',
        );
      }
    }
  }
  fail('Sign in with: gcloud auth application-default login');
}
const settings = await connect();
if (settings.halted) fail('Processing is halted (Settings › Budget). Resume it first.');

/** What the auth tests cost this calendar month, from the ledger. */
async function monthToDate(): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const snap = await db.collection('ledger').where('projectId', '==', PROJECT_ID).get();
  const entries = snap.docs
    .map((d) => d.data() as { createdAt?: number; category?: string; actual?: number })
    .filter((e) => (e.createdAt ?? 0) >= start.getTime());
  return costBreakdown(entries).total;
}

const cases = buildCases(targets, { only: list(args.only), envs });
if (!cases.length) fail('Nothing to test with these options.');

interface Mac {
  id: string;
  name: string;
  lastSeen?: number;
}

async function pickMac(): Promise<Mac | undefined> {
  const snap = await db.collection('devices').where('state', '==', 'approved').get();
  const macs = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Mac, 'id'>) }))
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  if (args.mac) return macs.find((m) => m.id === args.mac || m.name === args.mac);
  return macs[0];
}
const online = (m?: Mac) => !!m?.lastSeen && Date.now() - m.lastSeen < 3 * HEARTBEAT_MS;

// ── Pre-flight: everything here is free ─────────────────────────────────────

let mac: Mac | undefined;
try {
  mac = cases.some((c) => c.env === 'local') ? await pickMac() : undefined;
} catch (err) {
  fail(
    `Cannot read Firestore (${String(err)}).\nSign in once with: gcloud auth application-default login`,
  );
}
const warnings: string[] = [];
let runnable = cases;
if (cases.some((c) => c.env === 'local')) {
  if (!mac) {
    warnings.push('No paired Mac: local cases are skipped. Pair one with `pnpm mac setup <code>`.');
    runnable = runnable.filter((c) => c.env !== 'local');
  } else if (!online(mac)) {
    warnings.push(
      `${mac.name} is offline: local cases will wait for it. Start the daemon (pnpm dodo daemon).`,
    );
  }
}
const vault: VaultSummary[] = (await db.collection('vault').get()).docs.map((d) => ({
  id: d.id,
  name: String(d.get('name') ?? d.id),
  domains: (d.get('domains') as string[] | undefined) ?? [],
}));
const vaultUse: string[] = [];
for (const m of new Set(runnable.map((c) => c.method))) {
  if (m.useGoogleSession) continue;
  const named = m.vault;
  const entry = resolveVault(m, vault);
  if (entry) {
    m.vault = entry.id;
    vaultUse.push(`${m.label}: ${entry.name} (${entry.domains.join(', ')})`);
  } else if (m.vaultOptional && !named) {
    vaultUse.push(`${m.label}: no vault entry needed (uses your personal info)`);
  } else {
    const sites = (m.vaultHosts?.length ? m.vaultHosts : m.hosts).join(' or ');
    warnings.push(
      named
        ? `${m.label}: no vault entry "${named}" (${APP_URL}/settings, Vault).`
        : `${m.label}: no vault entry for ${sites}; the agent will have to ask you. Add one at ${APP_URL}/settings (Vault).`,
    );
  }
}
if (vaultUse.length) console.log(`\nVault entries:\n  ${vaultUse.join('\n  ')}`);
console.log(`\nAuth test: ${runnable.length} case${runnable.length === 1 ? '' : 's'}`);
for (const c of runnable) {
  const where = c.env === 'remote' ? 'remote (cloud browser)' : `local (${mac?.name})`;
  console.log(
    `  • ${c.method.label} on ${where}${c.method.mfa ? `, expects ${c.method.mfa}` : ''}`,
  );
}
for (const w of warnings) console.log(`  ! ${w}`);
printEstimate(runnable);
const spentThisMonth = await monthToDate().catch(() => undefined);
console.log(
  `  Auth tests this month so far: ${spentThisMonth === undefined ? 'unknown' : euro(spentThisMonth)} of the ${euro(monthCapEur)} monthly cap.`,
);
if (command === 'cost') process.exit(0);
console.log(
  'You need your phone: approve logins there and answer the agent in dodo (app or Telegram).',
);
if (!args['reuse-sessions']) {
  console.log(
    'Sites where the agent is already signed in get signed out first (your dodo Chrome profile on the Mac too). Use --reuse-sessions to keep them.',
  );
}
if (!runnable.length) fail('Nothing left to run.');
if (!args.yes && !(await yesNo('\nStart?', true))) process.exit(0);

const projectRef = db.doc(`projects/${PROJECT_ID}`);
const projectExists = (await projectRef.get()).exists;
await projectRef.set(
  {
    name: 'Auth tests',
    description: 'Login tests started by pnpm test:auth. Safe to delete.',
    monthlyBudget: Math.round(monthCapEur * 1_000_000),
    instructions: '',
    updatedAt: Date.now(),
    ...(projectExists ? {} : { createdAt: Date.now() }),
  },
  { merge: true },
);

// ── Run the cases: all at once; the Mac takes its own one after another ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function observe(taskId: string): Promise<Observation> {
  const [task, runs, messages] = await Promise.all([
    db.doc(`tasks/${taskId}`).get(),
    db.collection('runs').where('taskId', '==', taskId).get(),
    db.collection(`tasks/${taskId}/messages`).orderBy('createdAt').get(),
  ]);
  return {
    task: (task.data() ?? {}) as Observation['task'],
    runs: runs.docs
      .map((r) => r.data() as Observation['runs'][number])
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    messages: messages.docs.map((m) => m.data() as Observation['messages'][number]),
  };
}

interface Live {
  c: Case;
  taskId: string;
  createdAt: number;
  o?: Observation;
  seenMessages: Set<number>;
  seenRuns: Set<number>;
  lastLine: string;
  done: boolean;
}

/** Creates the case's task: remote ones start at once, local ones queue on the Mac in order. */
async function startCase(c: Case): Promise<Live> {
  const ref = await db.collection('tasks').add(
    taskDoc(c, {
      now: Date.now(),
      projectId: PROJECT_ID,
      macDevice: mac ? `mac:${mac.id}` : undefined,
      model: args.model,
      budget: Math.round(budgetEur * 1_000_000),
      reuseSessions: args['reuse-sessions'],
    }),
  );
  console.log(`  [${c.id}] ${APP_URL}/tasks/${ref.id}`);
  return {
    c,
    taskId: ref.id,
    createdAt: Date.now(),
    seenMessages: new Set(),
    seenRuns: new Set(),
    lastLine: '',
    done: false,
  };
}

/** Prints what is new on a case since the last look. */
function report(l: Live, o: Observation): void {
  const tag = `  [${l.c.id}]`;
  o.runs.forEach((r, i) => {
    if (l.seenRuns.has(i)) return;
    l.seenRuns.add(i);
    const on = r.device?.startsWith('mac:') ? (mac?.name ?? 'the Mac') : 'remote';
    console.log(`${tag} run ${i + 1} on ${on}`);
  });
  o.messages.forEach((m, i) => {
    if (l.seenMessages.has(i)) return;
    l.seenMessages.add(i);
    if (m.input) {
      const pic = m.input.image ? ' (with a picture)' : '';
      const code = m.input.secret ? ' (a code: it stays secret)' : '';
      console.log(`${tag} ? ${oneLine(m.input.prompt ?? m.body ?? '')}${pic}${code}`);
      console.log(`${tag}   answer in dodo (app or Telegram)`);
    } else if (m.author === 'agent' || m.author === 'system') {
      console.log(`${tag} ${m.author === 'agent' ? '›' : '·'} ${oneLine(m.body ?? '')}`);
    }
  });
  const line = o.task.statusLine?.text ?? '';
  if (line && line !== l.lastLine) {
    console.log(`${tag} status: ${oneLine(line)}`);
    l.lastLine = line;
  }
}

const claimOf = (o: Observation) =>
  [o.task.summary ?? '', ...o.messages.map((m) => m.body ?? '')]
    .map((t) => RESULT_LINE.exec(t))
    .find(Boolean);

/** Starts every case, then follows them all until each has ended or timed out. */
async function runAll(cases: Case[]): Promise<Live[]> {
  console.log('\nStarting the cases. Answer the agent in dodo when it asks; nothing to type here.');
  const live: Live[] = [];
  for (const c of cases) live.push(await startCase(c));
  while (live.some((l) => !l.done)) {
    await sleep(3000);
    for (const l of live.filter((x) => !x.done)) {
      const o = await observe(l.taskId);
      l.o = o;
      report(l, o);
      // The clock starts when the case's first run does: local cases wait for the Mac in turn.
      const startedAt = o.runs[0]?.startedAt;
      const late = startedAt
        ? Date.now() - startedAt > timeoutMs
        : Date.now() - l.createdAt > timeoutMs * cases.length;
      if (caseState(o).ended || late) {
        if (!caseState(o).ended) {
          o.timedOut = true;
          console.log(`  [${l.c.id}] ! no result after ${args.timeout} min`);
        }
        const claim = claimOf(o);
        console.log(
          `  [${l.c.id}] ${claim ? (claim[1]?.toLowerCase() === 'ok' ? 'signed in' : 'failed') : 'ended without an AUTH_RESULT line'}${claim?.[2] ? `: ${oneLine(claim[2])}` : ''}`,
        );
        l.done = true;
        await close(l.taskId, o);
      }
    }
  }
  return live;
}

/** With --ask: what you saw yourself, per case, once they have all ended. */
async function askTester(l: Live): Promise<TesterAnswers> {
  const tester: TesterAnswers = {};
  if (!args.ask || !l.o) return tester;
  console.log(`\n${l.c.method.label} on ${l.c.env}:`);
  if (claimOf(l.o)?.[1]?.toLowerCase() === 'ok') {
    tester.confirmed = await yesNo('  The agent says it signed in. Is that right?', true);
  }
  if (l.o.runs.some((r) => r.device?.startsWith('mac:'))) {
    tester.macInput = await yesNo(
      '  Did you have to do anything on the Mac itself (its Chrome window, Touch ID, a QR on its screen)?',
      false,
    );
  }
  const notes = await ask('  Notes (enter to skip): ');
  if (notes) tester.notes = notes;
  return tester;
}

async function resultOf(l: Live, tester: TesterAnswers): Promise<CaseResult> {
  const result = classify(l.c, l.o as Observation, tester);
  // The last Cloud Run slice is settled when the run ends, so the ledger is complete by now.
  const ledger = await db.collection('ledger').where('taskId', '==', l.taskId).get();
  const cost = costBreakdown(ledger.docs.map((d) => d.data()));
  // What the money went to, so a cost on a free (local) case is explained.
  for (const d of ledger.docs) {
    const e = d.data() as { actual?: number; description?: string; category?: string };
    if ((e.actual ?? 0) > 0) {
      console.log(
        `  [${l.c.id}]   ${euro((e.actual ?? 0) / 1_000_000)} ${e.description ?? e.category ?? ''}`,
      );
    }
  }
  result.costEur = Math.max(result.costEur, cost.total);
  result.costModelEur = cost.model;
  result.costCloudEur = cost.cloud;
  return result;
}

/** Stops a run still going and closes the task, which also drops its stored logins and codes. */
async function close(taskId: string, o: Observation) {
  if (args.keep) return;
  if (o.task.activeRunId) {
    await db.doc(`runs/${o.task.activeRunId}`).update({ interrupt: true });
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      if (!(await db.doc(`tasks/${taskId}`).get()).get('activeRunId')) break;
    }
  }
  await db.doc(`tasks/${taskId}`).update({ status: 'done', updatedAt: Date.now() });
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
};

const before = history();
const live = await runAll(runnable);
const results: CaseResult[] = [];
for (const l of live) {
  if (!l.o) continue;
  try {
    const r = await resultOf(l, await askTester(l));
    console.log(
      `  [${l.c.id}] cost ${euro(r.costEur)} (model ${euro(r.costModelEur ?? 0)}, cloud ${euro(r.costCloudEur ?? 0)})`,
    );
    results.push(r);
  } catch (err) {
    console.log(`  [${l.c.id}] ✗ ${String(err)}`);
  }
}
rl.close();

// ── Report ──────────────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
for (const r of results) r.date = date;
const outDir = path.join(root, 'tests/auth/results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const thisRun = renderReport(results, {
  date,
  note: args.model ? `Model: ${args.model}.` : undefined,
});
writeFileSync(path.join(outDir, `${stamp}.json`), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(path.join(outDir, `${stamp}.md`), `${thisRun}\n`);
console.log(`\n${thisRun}\n`);
const estimated = estimateCost(
  runnable.filter((c) => results.some((r) => r.id === c.id)),
  before,
  budgetEur,
).total;
const spent = results.reduce((sum, r) => sum + r.costEur, 0);
console.log(`Cost of this run: ${euro(spent)} (expected ${euro(estimated)}).`);
console.log(`Saved to tests/auth/results/${stamp}.md`);
// Started from `pnpm test:manual auth`: the report goes with the suite's log too.
const manualDir = process.env.DODO_MANUAL_REPORT_DIR;
if (manualDir) {
  mkdirSync(path.resolve(root, manualDir), { recursive: true });
  writeFileSync(path.resolve(root, manualDir, `auth-${stamp}.md`), `${thisRun}\n`);
}

// The overview keeps the latest result of every case, so a run of one method updates its row.
const store = storePath;
const overview = path.join(root, 'docs/AUTH_MATRIX.md');
if (results.length) {
  const merged = mergeResults(history(), results);
  writeFileSync(store, `${JSON.stringify(merged, null, 2)}\n`);
  if (existsSync(overview)) {
    writeFileSync(
      overview,
      replaceMatrix(readFileSync(overview, 'utf8'), renderReport(merged, { date })),
    );
  }
  // Formatted the way the lint check expects, so committing them keeps CI green.
  spawnSync('pnpm', ['exec', 'biome', 'format', '--write', store, overview], {
    cwd: root,
    stdio: 'ignore',
  });
  console.log('Updated docs/AUTH_MATRIX.md: commit it to keep the overview current.');
}
process.exit(0);
