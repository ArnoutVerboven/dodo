// End-to-end on the emulators with the fake model (no network, no cost):
// create an AI task → trigger enqueues a run → dispatcher claims it → the dev worker executes
// it → the agent updates summary/status, posts a message, finishes → ledger has entries.
//
//   firebase emulators:exec --only auth,firestore,storage,functions --project demo-dodo \
//     'node scripts/e2e-emulator.mjs'
import { spawn } from 'node:child_process';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
initializeApp({ projectId: 'demo-dodo' });
const db = getFirestore();

const worker = spawn('node', ['--env-file=apps/worker/.env.emulator', 'apps/worker/dist/dev.js'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
const fail = (msg) => {
  console.error(`E2E FAILED: ${msg}`);
  worker.kill();
  process.exit(1);
};
const until = async (label, check, timeoutMs = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`timeout waiting for ${label}`);
};

const now = Date.now();
await db.doc('settings/global').set(
  {
    halted: false,
    defaultTaskBudget: 500_000,
    monthlyBudget: 25_000_000,
    totalBudget: 35_000_000,
  },
  { merge: true },
);

// 1. A plain AI task runs to completion.
const task = await db.collection('tasks').add({
  title: 'E2E: summarise notes',
  titleSource: 'user',
  description: 'Summarise these notes: the meeting agreed to ship on Friday.',
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true },
  summary: '',
  externalRefs: {},
  createdAt: now,
  updatedAt: now,
});
console.log('created task', task.id);
const run = await until('run enqueued', async () => {
  const t = (await task.get()).data();
  return t?.activeRunId;
});
console.log('run', run);
const ended = await until(
  'run to end',
  async () => {
    const r = (await db.doc(`runs/${run}`).get()).data();
    return ['succeeded', 'failed', 'interrupted', 'budget_exhausted'].includes(r?.state)
      ? r
      : undefined;
  },
  120_000,
);
console.log('run ended', ended.state, ended.endReason, ended.error ?? '');
if (ended.state !== 'succeeded') fail(`run state ${ended.state}: ${ended.error}`);
const t = (await task.get()).data();
if (!t.summary.includes('Fake summary')) fail(`summary not written: ${JSON.stringify(t.summary)}`);
if (t.status !== 'review') fail(`task status ${t.status}, expected review`);
if (t.activeRunId) fail('activeRunId not cleared');
const msgs = await db.collection(`tasks/${task.id}/messages`).get();
if (!msgs.docs.some((d) => d.get('author') === 'agent')) fail('no agent message');
const ledger = await db.collection('ledger').where('taskId', '==', task.id).get();
if (ledger.empty) fail('no ledger entries');
const spent = ledger.docs.reduce((s, d) => s + d.get('actual'), 0);
console.log(`ledger: ${ledger.size} entries, ${spent} micro-EUR`);
if (!ended.sessionPath || !ended.tracePath) fail('session/trace not archived');
const events = await db.collection(`runs/${run}/events`).get();
if (!events.empty) fail('events not cleaned up after archival');

// 2. A task that asks a question parks, and the answer resumes it to completion.
const ask = await db.collection('tasks').add({
  title: 'E2E: ask me',
  titleSource: 'user',
  description: 'Please ask me a question before you start.',
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true },
  summary: '',
  externalRefs: {},
  createdAt: now,
  updatedAt: now,
});
const pending = await until('input request', async () => {
  const m = await db.collection(`tasks/${ask.id}/messages`).where('author', '==', 'agent').get();
  return m.docs.find((d) => d.get('input'));
});
const askTask = (await ask.get()).data();
if (askTask.status !== 'needs_input') fail(`asking task status ${askTask.status}`);
console.log('input requested:', pending.get('input').prompt);
await pending.ref.update({ 'input.answer': { value: 'B', answeredAt: Date.now() } });
await until(
  'resume to finish',
  async () => {
    const d = (await ask.get()).data();
    return d.status === 'review' && !d.activeRunId ? d : undefined;
  },
  120_000,
);
const runs = await db.collection('runs').where('taskId', '==', ask.id).get();
console.log(`ask task finished after ${runs.size} runs`);
if (runs.size !== 2) fail(`expected 2 runs, got ${runs.size}`);

// 3. A task stuck behind a dead worker is released when the user comments.
const stuck = await db.collection('tasks').add({
  title: 'E2E: stuck',
  titleSource: 'user',
  description: 'Summarise: nothing happened.',
  status: 'in_progress',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true },
  summary: '',
  externalRefs: {},
  activeRunId: 'dead-run',
  createdAt: now,
  updatedAt: now,
});
await db.doc('runs/dead-run').set({
  taskId: stuck.id,
  device: 'gcp',
  model: 'gemini-2.5-flash',
  state: 'running',
  trigger: 'new',
  generation: 1,
  interrupt: false,
  attempts: 1,
  spent: 0,
  steps: 0,
  lease: { owner: 'run:dead-run', expiresAt: now - 10 * 60_000 },
  createdAt: now - 20 * 60_000,
  updatedAt: now - 10 * 60_000,
});
await db
  .collection(`tasks/${stuck.id}/messages`)
  .add({ author: 'user', body: 'Still there?', createdAt: Date.now() });
await until(
  'stuck task to recover',
  async () => {
    const d = (await stuck.get()).data();
    return d.status === 'review' && !d.activeRunId ? d : undefined;
  },
  120_000,
);
const dead = (await db.doc('runs/dead-run').get()).data();
if (dead.state !== 'failed' || dead.endReason !== 'lease_lost')
  fail(`dead run not reaped: ${dead.state}`);
console.log('stuck task recovered');

console.log('E2E OK');
worker.kill();
process.exit(0);
