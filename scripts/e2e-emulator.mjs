// End-to-end on the emulators with the fake model (no network, no cost):
// create an AI task → trigger enqueues a run → dispatcher claims it → the dev worker executes
// it → the agent updates summary/status, posts a message, finishes → ledger has entries.
//
//   firebase emulators:exec --only auth,firestore,storage,functions --project demo-dodo \
//     'node scripts/e2e-emulator.mjs'
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

// 4. A tool that needs approval parks the task with an approval card; "yes" resumes and runs it.
const fetchTask = await db.collection('tasks').add({
  title: 'E2E: fetch',
  titleSource: 'user',
  description: 'Please fetch http://127.0.0.1:4400/ and summarise it.',
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true },
  summary: '',
  externalRefs: {},
  createdAt: now,
  updatedAt: now,
});
const approval = await until('approval request', async () => {
  const m = await db
    .collection(`tasks/${fetchTask.id}/messages`)
    .where('author', '==', 'agent')
    .get();
  return m.docs.find((d) => d.get('input')?.kind === 'approval');
});
const card = approval.get('input');
console.log('approval requested:', card.prompt);
if (card.suggestedRule !== 'Http(domain:127.0.0.1)') fail(`unexpected rule ${card.suggestedRule}`);
await approval.ref.update({ 'input.answer': { value: 'yes', answeredAt: Date.now() } });
const fetched = await until(
  'fetch task to finish',
  async () => {
    const d = (await fetchTask.get()).data();
    return d.status === 'review' && !d.activeRunId ? d : undefined;
  },
  120_000,
);
if (!fetched.summary.includes('Fake summary')) fail('fetch task summary missing');
const fetchRuns = await db.collection('runs').where('taskId', '==', fetchTask.id).get();
if (fetchRuns.size !== 2) fail(`expected 2 runs for the fetch task, got ${fetchRuns.size}`);
console.log('approval flow ok');

// 5. A Mac pairs with a one-time code, its daemon claims a run addressed to it and runs it with
//    the run identity; the task's folder is used only when the daemon allows it.
const macHome = await mkdtemp(path.join(os.tmpdir(), 'dodo-mac-'));
const macFolder = path.join(macHome, 'code');
await mkdir(macFolder, { recursive: true });
const macEnv = { ...process.env, DODO_HOME: macHome, DODO_CREDENTIAL_STORE: 'file' };
const cli = (...args) =>
  new Promise((resolve) => {
    const p = spawn('node', ['apps/cli/dist/index.js', ...args], {
      env: macEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ code, out }));
  });
await db
  .doc('settings/global')
  .set({ devicePairing: { code: 'e2e-pair-code', createdAt: Date.now() } }, { merge: true });
const login = await cli('login', 'e2e-pair-code', '--emulator', '--name', 'E2E Mac');
console.log(login.out.trim());
if (login.code !== 0) fail(`dodo login exited ${login.code}`);
const macConfig = JSON.parse(await readFile(path.join(macHome, 'config.json'), 'utf8'));
const device = (await db.doc(`devices/${macConfig.deviceId}`).get()).data();
if (device?.state !== 'approved' || device.name !== 'E2E Mac')
  fail(`device not registered: ${JSON.stringify(device)}`);
if ((await db.doc('settings/global').get()).get('devicePairing')) fail('pairing code not consumed');
const again = await cli('login', 'e2e-pair-code', '--emulator');
if (again.code === 0) fail('a second login with the same code should fail');
const added = await cli('folders', 'add', macFolder);
if (added.code !== 0) fail(`dodo folders add failed: ${added.out}`);
const daemon = spawn('node', ['apps/cli/dist/index.js', 'daemon', '--once'], {
  env: macEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const daemonExited = new Promise((resolve) => daemon.on('close', resolve));
daemon.stdout.on('data', (c) => process.stdout.write(`  daemon: ${c}`));
daemon.stderr.on('data', (c) => process.stdout.write(`  daemon: ${c}`));
await until('daemon heartbeat', async () => {
  const d = (await db.doc(`devices/${macConfig.deviceId}`).get()).data();
  return d?.version ? d : undefined;
});
const macTask = await db.collection('tasks').add({
  title: 'E2E: on the Mac',
  titleSource: 'user',
  description: 'Summarise: the Mac did it.',
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true, device: `mac:${macConfig.deviceId}`, folder: macFolder },
  summary: '',
  externalRefs: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const macRunId = await until('mac run enqueued', async () =>
  (await macTask.get()).get('activeRunId'),
);
const macRun = await until(
  'mac run to end',
  async () => {
    const r = (await db.doc(`runs/${macRunId}`).get()).data();
    return ['succeeded', 'failed', 'interrupted'].includes(r?.state) ? r : undefined;
  },
  120_000,
);
console.log('mac run ended', macRun.state, macRun.endReason, macRun.error ?? '');
if (macRun.state !== 'succeeded') fail(`mac run ${macRun.state}: ${macRun.error}`);
if (macRun.execution !== `mac:${macConfig.deviceId}`)
  fail(`mac run executed by ${macRun.execution}`);
if (macRun.infraReservation) fail('mac run should not meter infra');
const macDone = (await macTask.get()).data();
if (macDone.status !== 'review' || !macDone.summary.includes('Fake summary'))
  fail('mac task not finished');
const daemonExit = await daemonExited;
if (daemonExit !== 0) fail(`daemon --once exited ${daemonExit}`);
console.log('mac flow ok');

// 5b. The worker on the Mac runs inside the sandbox: it works in the task folder, but cannot read
//     the daemon's own files and cannot reach a host the task's policy does not allow.
const sandboxDaemon = spawn('node', ['apps/cli/dist/index.js', 'daemon', '--once'], {
  env: macEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const sandboxDaemonExited = new Promise((resolve) => sandboxDaemon.on('close', resolve));
let sandboxDaemonOut = '';
sandboxDaemon.stdout.on('data', (c) => {
  sandboxDaemonOut += c;
  process.stdout.write(`  daemon: ${c}`);
});
sandboxDaemon.stderr.on('data', (c) => {
  sandboxDaemonOut += c;
  process.stdout.write(`  daemon: ${c}`);
});
const probe = [
  `cat ${path.join(macHome, 'auth.json')} && echo AUTH_READ`,
  `cat ${path.join(macHome, 'config.json')} && echo CONFIG_READ`,
  'curl -sS -m 15 https://example.com/ -o /dev/null && echo CURL_OK',
  'echo ran > sandbox-marker.txt && echo MARKER_OK',
].join('; ');
const sandboxTask = await db.collection('tasks').add({
  title: 'E2E: sandbox',
  titleSource: 'user',
  description: `Run: ${probe}`,
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true, device: `mac:${macConfig.deviceId}`, folder: macFolder },
  allowRules: ['Bash'],
  summary: '',
  externalRefs: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const sandboxDone = await until(
  'sandbox task to finish',
  async () => {
    const d = (await sandboxTask.get()).data();
    return d.status === 'review' && !d.activeRunId ? d : undefined;
  },
  120_000,
);
if ((await sandboxDaemonExited) !== 0) fail(`sandbox daemon --once exited: ${sandboxDaemonOut}`);
if (!/sandbox on/.test(sandboxDaemonOut))
  fail(`daemon did not sandbox the worker: ${sandboxDaemonOut}`);
const probeOut = sandboxDone.summary;
console.log('sandbox probe:', probeOut.replace(/\s+/g, ' ').slice(0, 400));
if (!probeOut.includes('MARKER_OK')) fail('the command did not run in the task folder');
await readFile(path.join(macFolder, 'sandbox-marker.txt')).catch(() =>
  fail('no write to the task folder'),
);
if (/AUTH_READ|CONFIG_READ|stsTokenManager|deviceId/.test(probeOut))
  fail("the worker could read the daemon's files");
if (/CURL_OK/.test(probeOut)) fail('the worker reached a host the policy does not allow');
if (!/refused|403|denied/i.test(`${probeOut}\n${sandboxDaemonOut}`))
  fail('no refusal was logged for example.com');
console.log('sandbox ok');

// 6. A revoked Mac cannot claim: its queued run waits and the task says so.
await db.doc(`devices/${macConfig.deviceId}`).update({ state: 'revoked', updatedAt: Date.now() });
const macStatus = await cli('status');
if (!/revoked/.test(macStatus.out)) fail(`dodo status after revoke: ${macStatus.out}`);
const revokedTask = await db.collection('tasks').add({
  title: 'E2E: revoked Mac',
  titleSource: 'user',
  description: 'Summarise: nothing.',
  status: 'todo',
  priority: 'none',
  tags: ['e2e'],
  ai: { enabled: true, device: `mac:${macConfig.deviceId}` },
  summary: '',
  externalRefs: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
await until('revoked run to fail', async () => {
  const d = (await revokedTask.get()).data();
  return d.status === 'needs_input' && /not paired/.test(d.statusLine?.text ?? '') ? d : undefined;
});
const revokedDaemon = await cli('daemon', '--once');
if (revokedDaemon.code === 0 || !/revoked/i.test(revokedDaemon.out))
  fail(`revoked daemon: ${revokedDaemon.out}`);
console.log('revoked mac ok');

console.log('E2E OK');
worker.kill();
process.exit(0);
