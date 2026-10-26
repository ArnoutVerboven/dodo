// Seeds the local Firebase emulators with an owner account and example data.
//   pnpm emulators        (in one terminal)
//   pnpm seed             (in another)
// Then open the web app with `pnpm --filter @dodo/web dev:emulators` and use "Sign in as local owner".
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
initializeApp({ projectId: 'demo-dodo', storageBucket: 'demo-dodo.appspot.com' });
const auth = getAuth();
const db = getFirestore();

const email = 'owner@dodo.local';
let user;
try {
  user = await auth.getUserByEmail(email);
} catch {
  user = await auth.createUser({ email, password: 'dodo-local', displayName: 'Local owner' });
}
await auth.setCustomUserClaims(user.uid, { dodo_owner: true });

const now = Date.now();
const M = 1_000_000;
await db.doc('settings/global').set({
  connector: 'custom',
  defaults: { model: 'gemini-2.5-flash', device: 'gcp' },
  monthlyBudget: 35 * M,
  defaultTaskBudget: 0.5 * M,
  halted: false,
});
await db.doc('projects/home').set({
  name: 'Home admin',
  description: 'Bills, contracts, paperwork',
  defaults: { device: 'gcp' },
  instructions: 'Never pay anything without approval.',
  createdAt: now,
  updatedAt: now,
});
await db.doc('projects/dodo').set({
  name: 'dodo',
  description: 'This project',
  defaults: { repo: 'ArnoutVerboven/dodo', device: 'mac:default', folder: '~/code/dodo' },
  monthlyBudget: 10 * M,
  instructions: '',
  createdAt: now,
  updatedAt: now,
});

const task = (id, t) =>
  db.doc(`tasks/${id}`).set({
    titleSource: 'user',
    description: '',
    status: 'todo',
    priority: 'none',
    tags: [],
    ai: { enabled: false },
    summary: '',
    externalRefs: {},
    createdAt: now - 3600_000,
    updatedAt: now,
    ...t,
  });
await task('energy', {
  title: 'Compare energy contracts for next year',
  description:
    'My contract with the current provider ends in December. Find the 3 best fixed-price offers for our usage (see last bill).',
  status: 'needs_input',
  priority: 'high',
  tags: ['admin'],
  projectId: 'home',
  dueDate: '2026-11-30',
  ai: { enabled: true, budget: 0.8 * M },
  summary:
    '**Two fixed offers beat the current contract by ~180 EUR/year.** Engie Flow is cheapest; Luminus Comfy is second but has better reviews.\n\n| Offer | Year cost | Fixed until |\n|---|---|---|\n| Engie Flow | 1,420 EUR | 12/2027 |\n| Luminus Comfy | 1,465 EUR | 12/2027 |',
  statusLine: {
    text: 'Offers compared; waiting for your choice before starting the switch.',
    nextAction: 'Pick an offer in the thread',
    needsYou: true,
  },
});
await task('readme', {
  title: 'Write a README for the CLI',
  status: 'in_progress',
  tags: ['docs'],
  projectId: 'dodo',
  ai: { enabled: true },
  statusLine: { text: 'Drafting usage section', needsYou: false },
});
await task('dentist', { title: 'Book dentist appointment', priority: 'medium', tags: ['health'] });
await task('done1', { title: 'Renew passport', status: 'done', tags: ['admin'] });

const msgs = db.collection('tasks/energy/messages');
await msgs.doc('m1').set({
  author: 'user',
  body: 'Please compare energy offers for 2027.',
  createdAt: now - 3500_000,
});
await msgs.doc('m2').set({
  author: 'agent',
  runId: 'run_abc123',
  body: 'I compared 11 fixed-price offers against your last bill (3,450 kWh). Two clearly win; details in the summary.',
  createdAt: now - 1800_000,
});
await msgs.doc('m3').set({
  author: 'agent',
  runId: 'run_abc123',
  body: 'Which offer should I prepare the switch for?',
  input: {
    kind: 'choice',
    prompt: 'Which offer should I prepare the switch for?',
    options: ['Engie Flow', 'Luminus Comfy', 'Neither'],
  },
  createdAt: now - 1700_000,
});
await db.doc('tasks/energy/artifacts/a1').set({
  kind: 'link',
  role: 'reference',
  name: 'VREG comparison tool',
  url: 'https://vtest.vreg.be',
  createdBy: 'user',
  createdAt: now,
});

const month = new Date().toISOString().slice(0, 7);
await db.doc('budgets/total').set({ limit: 35 * M, reserved: 0, spent: 0.42 * M });
await db.doc(`budgets/global_${month}`).set({ limit: 25 * M, reserved: 0, spent: 0.42 * M });
await db.doc('budgets/task_energy').set({ limit: 0.8 * M, reserved: 0, spent: 0.31 * M });
await db.doc('budgets/task_readme').set({ limit: 0.5 * M, reserved: 0.02 * M, spent: 0.11 * M });
const ledger = db.collection('ledger');
await ledger.add({
  category: 'tokens',
  actual: 0.27 * M,
  reserved: 0.4 * M,
  overrun: 0,
  description: 'gemini-2.5-flash call',
  taskId: 'energy',
  projectId: 'home',
  model: 'gemini-2.5-flash',
  createdAt: now - 1800_000,
  scopeKeys: [],
  reservationId: 'r1',
});
await ledger.add({
  category: 'infra',
  actual: 0.04 * M,
  reserved: 0.05 * M,
  overrun: 0,
  description: 'Cloud Run 6 min',
  taskId: 'energy',
  projectId: 'home',
  createdAt: now - 1700_000,
  scopeKeys: [],
  reservationId: 'r2',
});
await ledger.add({
  category: 'tokens',
  actual: 0.11 * M,
  reserved: 0.2 * M,
  overrun: 0,
  description: 'gemini-2.5-flash call',
  taskId: 'readme',
  projectId: 'dodo',
  model: 'gemini-2.5-flash',
  createdAt: now - 600_000,
  scopeKeys: [],
  reservationId: 'r3',
});
// Runs, so the thread can show the steps behind agent messages.
const run = (id, fields) =>
  db.doc(`runs/${id}`).set({
    device: 'gcp',
    model: 'gemini-2.5-flash',
    trigger: 'new',
    generation: 1,
    interrupt: false,
    attempts: 1,
    ...fields,
  });
const ev = (runId, seq, type, summary, at, extra = {}) => ({
  id: `e${seq}`,
  runId,
  seq,
  type,
  summary,
  data: {},
  createdAt: at,
  ...extra,
});
// A finished run whose trace was archived to Storage, as the control plane does.
const energyTrace = [
  ev('run_abc123', 1, 'run_started', 'Run started on gcp', now - 2400_000),
  ev('run_abc123', 2, 'model_call', 'gemini-2.5-flash', now - 2390_000, { cost: 1200 }),
  ev(
    'run_abc123',
    3,
    'tool_call',
    'web_search("fixed energy contract Belgium 2027")',
    now - 2300_000,
    {
      data: { query: 'fixed energy contract Belgium 2027' },
    },
  ),
  ev('run_abc123', 4, 'tool_result', '11 offers found', now - 2200_000),
  ev('run_abc123', 5, 'tool_call', 'post_message', now - 1800_000),
  ev('run_abc123', 6, 'tool_call', 'request_input(choice)', now - 1700_000),
  ev('run_abc123', 7, 'run_finished', 'Waiting for input', now - 1700_000),
];
let traceArchived = true;
try {
  await getStorage()
    .bucket()
    .file('runs/run_abc123/trace.json')
    .save(JSON.stringify(energyTrace), { contentType: 'application/json' });
} catch (e) {
  traceArchived = false;
  console.warn('Storage emulator not running; skipping the archived trace.', e.message);
}
await run('run_abc123', {
  taskId: 'energy',
  projectId: 'home',
  state: 'waiting_input',
  endReason: 'waiting_input',
  ...(traceArchived && { tracePath: 'runs/run_abc123/trace.json' }),
  spent: 310_000,
  steps: 7,
  createdAt: now - 2400_000,
  startedAt: now - 2400_000,
  endedAt: now - 1700_000,
  updatedAt: now - 1700_000,
});
// A run that is working right now, with its live events in Firestore.
await run('run_live', {
  taskId: 'readme',
  projectId: 'dodo',
  state: 'running',
  spent: 110_000,
  steps: 3,
  createdAt: now - 120_000,
  startedAt: now - 120_000,
  updatedAt: now - 10_000,
});
for (const e of [
  ev('run_live', 1, 'run_started', 'Run started on gcp', now - 120_000),
  ev('run_live', 2, 'tool_call', 'read_file("README.md")', now - 60_000),
  ev('run_live', 3, 'model_call', 'gemini-2.5-flash', now - 10_000, { cost: 900 }),
]) {
  const { id, ...data } = e;
  await db.doc(`runs/run_live/events/${id}`).set(data);
}

console.log(`Seeded. Owner: ${email} / dodo-local`);
