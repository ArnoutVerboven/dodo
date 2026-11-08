/**
 * Manual auth test: logs in with each configured method (itsme, Google, a password login) on
 * your Mac and remotely, through real dodo tasks, and writes down what works where.
 *
 *   pnpm test:auth                         # every enabled method, local and remote
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
  type Env,
  mergeResults,
  type Observation,
  parseTargets,
  RESULT_LINE,
  renderReport,
  replaceMatrix,
  type TesterAnswers,
  taskDescription,
  taskDoc,
} from './matrix.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const APP_URL = 'https://dodo-app.web.app';
const PROJECT_ID = 'auth-tests';
const HEARTBEAT_MS = 30_000;

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    env: { type: 'string' },
    targets: { type: 'string', default: path.join(root, 'tests/auth/targets.json') },
    mac: { type: 'string' },
    model: { type: 'string' },
    budget: { type: 'string', default: '0.40' },
    'month-cap': { type: 'string', default: '5' },
    timeout: { type: 'string', default: '15' },
    'reuse-sessions': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    project: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`pnpm test:auth [options]

  --only itsme,google   methods to test (ids from targets.json); default: every enabled one
  --env local,remote    where to test; default: both
  --targets <file>      default tests/auth/targets.json (copy targets.example.json)
  --mac <id|name>       the Mac for local cases; default: the one seen most recently
  --model <id>          model for the agent; default: your usual one
  --budget 0.40         budget cap per case in EUR
  --month-cap 5         monthly cap of the "Auth tests" project in EUR
  --timeout 15          minutes before a case counts as timed out
  --reuse-sessions      keep existing logins instead of signing out first
  --keep                leave the test tasks open instead of closing them
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

const targetsPath = path.resolve(args.targets as string);
if (!existsSync(targetsPath)) {
  fail(
    `No ${path.relative(root, targetsPath)}. Copy tests/auth/targets.example.json to tests/auth/targets.json and fill in your sites and vault entries.`,
  );
}
const targets = parseTargets(JSON.parse(readFileSync(targetsPath, 'utf8')));
const cases = buildCases(targets, { only: list(args.only), envs });
if (!cases.length) fail('Nothing to test with these options.');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();
const yesNo = async (q: string, def?: boolean): Promise<boolean | undefined> => {
  const hint = def === undefined ? 'y/n/enter to skip' : def ? 'Y/n' : 'y/N';
  const a = (await ask(`${q} [${hint}] `)).toLowerCase();
  if (!a) return def;
  return /^y/.test(a);
};

if (args['dry-run']) {
  console.log(`Plan: ${cases.length} case${cases.length === 1 ? '' : 's'}\n`);
  for (const c of cases) {
    console.log(
      `── ${c.id} ──\n${taskDescription(c, { reuseSessions: args['reuse-sessions'] })}\n`,
    );
  }
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
for (const m of new Set(runnable.map((c) => c.method))) {
  if (!m.vault) continue;
  const entry = await db.doc(`vault/${m.vault}`).get();
  if (!entry.exists) {
    warnings.push(`${m.label}: no vault entry "${m.vault}" (Settings › Vault).`);
    continue;
  }
  const domains = (entry.get('domains') as string[] | undefined) ?? [];
  const covered = (h: string) =>
    domains.some((d) => {
      const x = d.replace(/^\*\./, '');
      return h === x || h.endsWith(`.${x}`);
    });
  const missing = m.hosts.filter((h) => !covered(h));
  if (missing.length && missing.length === m.hosts.length) {
    warnings.push(
      `${m.label}: vault entry "${m.vault}" is for ${domains.join(', ')}, none of ${m.hosts.join(', ')}.`,
    );
  }
}
const settings = (await db.doc('settings/global').get()).data() ?? {};
if (settings.halted) fail('Processing is halted (Settings › Budget). Resume it first.');

console.log(`\nAuth test: ${runnable.length} case${runnable.length === 1 ? '' : 's'}`);
for (const c of runnable) {
  const where = c.env === 'remote' ? 'remote (cloud browser)' : `local (${mac?.name})`;
  console.log(
    `  • ${c.method.label} on ${where}${c.method.mfa ? `, expects ${c.method.mfa}` : ''}`,
  );
}
for (const w of warnings) console.log(`  ! ${w}`);
console.log(
  `\nCost: at most €${budgetEur.toFixed(2)} per case (€${(budgetEur * runnable.length).toFixed(2)} in all), capped at €${monthCapEur.toFixed(2)} a month for the "Auth tests" project.`,
);
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

// ── Run the cases, one at a time (MFA requests expire, and you can do one at a time) ──

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

async function runCase(c: Case, n: number): Promise<CaseResult> {
  const where = c.env === 'remote' ? 'remote' : (mac?.name ?? 'Mac');
  console.log(`\n━━ ${n}/${runnable.length}  ${c.method.label} on ${where} ━━`);
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
  console.log(`  Task: ${APP_URL}/tasks/${ref.id}`);

  const started = Date.now();
  const seenMessages = new Set<number>();
  const seenRuns = new Set<number>();
  let lastLine = '';
  let o: Observation = await observe(ref.id);
  while (true) {
    o = await observe(ref.id);
    o.runs.forEach((r, i) => {
      if (seenRuns.has(i)) return;
      seenRuns.add(i);
      const on = r.device?.startsWith('mac:') ? (mac?.name ?? 'the Mac') : 'remote';
      console.log(`  · run ${i + 1} on ${on}`);
    });
    o.messages.forEach((m, i) => {
      if (seenMessages.has(i)) return;
      seenMessages.add(i);
      if (m.input) {
        const pic = m.input.image ? ' (with a picture)' : '';
        const code = m.input.secret ? ' (a code: answer in dodo, it stays secret)' : '';
        console.log(`  ? ${oneLine(m.input.prompt ?? m.body ?? '')}${pic}${code}`);
        console.log('    Answer in dodo (app or Telegram).');
      } else if (m.author === 'agent' || m.author === 'system') {
        console.log(`  ${m.author === 'agent' ? '›' : '·'} ${oneLine(m.body ?? '')}`);
      }
    });
    const line = o.task.statusLine?.text ?? '';
    if (line && line !== lastLine) {
      console.log(`  status: ${oneLine(line)}`);
      lastLine = line;
    }
    if (caseState(o).ended) break;
    if (Date.now() - started > timeoutMs) {
      o.timedOut = true;
      console.log(`  ! no result after ${args.timeout} min`);
      break;
    }
    await sleep(3000);
  }

  const claim = [o.task.summary ?? '', ...o.messages.map((m) => m.body ?? '')]
    .map((t) => RESULT_LINE.exec(t))
    .find(Boolean);
  console.log(
    claim
      ? `  Agent: ${claim[1]?.toLowerCase() === 'ok' ? 'signed in' : 'failed'}${claim[2] ? `: ${oneLine(claim[2])}` : ''}`
      : '  Agent: no AUTH_RESULT line',
  );
  const tester: TesterAnswers = {};
  if (claim?.[1]?.toLowerCase() === 'ok') tester.confirmed = await yesNo('  Is that right?', true);
  const ranOnMac = o.runs.some((r) => r.device?.startsWith('mac:'));
  if (ranOnMac) {
    tester.macInput = await yesNo(
      '  Did you have to do anything on the Mac itself (its Chrome window, Touch ID, a QR on its screen)?',
      false,
    );
  }
  const notes = await ask('  Notes (MFA you did, anything odd; enter to skip): ');
  if (notes) tester.notes = notes;

  await close(ref.id, o);
  return classify(c, o, tester);
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

const results: CaseResult[] = [];
let n = 0;
for (const c of runnable) {
  n++;
  try {
    results.push(await runCase(c, n));
  } catch (err) {
    console.log(`  ✗ ${String(err)}`);
  }
  if (n < runnable.length && !args.yes && !(await yesNo('Next case?', true))) break;
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
console.log(`Saved to tests/auth/results/${stamp}.md`);
// Started from `pnpm test:manual auth`: the report goes with the suite's log too.
const manualDir = process.env.DODO_MANUAL_REPORT_DIR;
if (manualDir) {
  mkdirSync(path.resolve(root, manualDir), { recursive: true });
  writeFileSync(path.resolve(root, manualDir, `auth-${stamp}.md`), `${thisRun}\n`);
}

// The overview keeps the latest result of every case, so a run of one method updates its row.
const store = path.join(root, 'docs/auth-matrix.json');
const overview = path.join(root, 'docs/AUTH_MATRIX.md');
if (results.length) {
  const before: CaseResult[] = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
  const merged = mergeResults(before, results);
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
