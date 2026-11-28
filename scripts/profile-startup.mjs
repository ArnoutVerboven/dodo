// Startup and resume latency on the emulators, phase by phase (fake model, no network, no cost).
// Each scenario runs a few times; the worker's startup clock (packages/agent/src/startup-clock.ts)
// rides on the first model reply's trace event, which this script reads live.
//
//   firebase emulators:exec --only auth,firestore,storage,functions --project demo-dodo \
//     'node scripts/profile-startup.mjs [repeats]'
//
// Needs `pnpm build`. The Mac scenarios pair a scratch "Mac" and run the real daemon (sandboxed
// when bubblewrap and socat are installed), the local-model one against a stub OpenAI server.
// Prints one JSON line per measured run, then a table of medians.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
initializeApp({ projectId: 'demo-dodo' });
const db = getFirestore();
const REPEATS = Number(process.argv[2] ?? 3);
const results = [];

const children = [];
const fail = (msg) => {
  console.error(`PROFILE FAILED: ${msg}`);
  for (const c of children) c.kill();
  process.exit(1);
};
const until = async (label, check, timeoutMs = 90_000, every = 50) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  fail(`timeout waiting for ${label}`);
};

/** The first model reply's startup summary for a run, read from its live trace. */
const startupOf = (runId) =>
  new Promise((resolve) => {
    const unsub = db
      .collection(`runs/${runId}/events`)
      .where('type', '==', 'model_response')
      .onSnapshot((snap) => {
        const hit = snap.docs.find((d) => d.get('data.startup'));
        if (hit) {
          unsub();
          resolve(hit.get('data.startup'));
        }
      });
  });

const ended = (runId) =>
  until(
    `run ${runId} to end`,
    async () => {
      const r = (await db.doc(`runs/${runId}`).get()).data();
      return ['succeeded', 'failed', 'interrupted', 'waiting_input', 'budget_exhausted'].includes(
        r?.state,
      )
        ? r
        : undefined;
    },
    120_000,
    100,
  );

const record = (scenario, i, extra, startup) => {
  const marks = { ...extra, ...startup.marks };
  const sorted = Object.entries(marks).sort((a, b) => a[1] - b[1]);
  const phases = sorted.slice(1).map(([p, at], k) => [p, at - sorted[k][1]]);
  const total = sorted.at(-1)[1] - sorted[0][1];
  const row = { scenario, i, total, phases: Object.fromEntries(phases) };
  results.push(row);
  console.log(JSON.stringify(row));
};

const newTask = (fields) => {
  const now = Date.now();
  return db.collection('tasks').add({
    titleSource: 'user',
    status: 'todo',
    priority: 'none',
    tags: ['profile'],
    summary: '',
    externalRefs: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
};

/** New task → first model reply. */
async function profileNew(scenario, ai, description = 'Summarise: the meeting agreed to ship.') {
  for (let i = 0; i < REPEATS; i++) {
    const created = Date.now();
    const task = await newTask({
      title: `${scenario} ${i}`,
      description,
      ai: { enabled: true, ...ai },
    });
    const runId = await until(
      'run enqueued',
      async () => (await task.get()).get('activeRunId'),
      90_000,
      20,
    );
    const startup = await startupOf(runId);
    record(scenario, i, { task_created: created }, startup);
    await ended(runId);
    await until('task idle', async () => !(await task.get()).get('activeRunId'));
  }
}

/**
 * A remote browser run holds its worker for the answer (10 min): the heartbeat delivers it.
 * Measures answer → the same run's next model call.
 */
async function profileHold(scenario, ai) {
  for (let i = 0; i < REPEATS; i++) {
    const task = await newTask({
      title: `${scenario} ${i}`,
      description: 'Please ask me a question before you start.',
      ai: { enabled: true, ...ai },
    });
    const pending = await until('input request', async () => {
      const m = await db
        .collection(`tasks/${task.id}/messages`)
        .where('author', '==', 'agent')
        .get();
      return m.docs.find((d) => d.get('input'));
    });
    const runId = (await task.get()).get('activeRunId');
    await until('run holding', async () => (await db.doc(`runs/${runId}`).get()).get('awaiting'));
    const calls = async () =>
      (await db.collection(`runs/${runId}/events`).where('type', '==', 'model_call').get()).size;
    const before = await calls();
    const answered = Date.now();
    await pending.ref.update({ 'input.answer': { value: 'B', answeredAt: answered } });
    await until('next model call', async () => (await calls()) > before, 60_000, 20);
    const row = {
      scenario,
      i,
      total: Date.now() - answered,
      phases: { answer_to_next_model_call: Date.now() - answered },
    };
    results.push(row);
    console.log(JSON.stringify(row));
    await ended(runId);
    await until('task idle', async () => !(await task.get()).get('activeRunId'));
  }
}

await db.doc('settings/global').set(
  {
    halted: false,
    defaultTaskBudget: 5_000_000,
    monthlyBudget: 25_000_000,
    totalBudget: 35_000_000,
  },
  { merge: true },
);

// Remote: the dev worker stands in for Cloud Run Jobs (no container start, no image pull).
const worker = spawn('node', ['--env-file=apps/worker/.env.emulator', 'apps/worker/dist/dev.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(worker);
let workerLog = '';
worker.stdout.on('data', (c) => (workerLog += c));
worker.stderr.on('data', (c) => (workerLog += c));

await profileNew('remote new (dodo loop)', { harness: 'dodo-loop', browser: 'none' });
await profileNew('remote new (pi)', { browser: 'none' });
await profileHold('remote answer during hold (dodo loop)', {
  harness: 'dodo-loop',
  browser: 'none',
});
worker.kill();

// Remote with a browser: the dev worker as the browser image runs it (headless Chromium).
// PROFILE_BROWSERS points at a Playwright browsers folder; without it this scenario is skipped.
if (process.env.PROFILE_BROWSERS) {
  const bworker = spawn(
    'node',
    ['--env-file=apps/worker/.env.emulator', 'apps/worker/dist/dev.js'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DODO_BROWSER: 'headless',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PROFILE_BROWSERS,
      },
    },
  );
  children.push(bworker);
  bworker.stdout.on('data', (c) => (workerLog += c));
  bworker.stderr.on('data', (c) => (workerLog += c));
  await profileNew('remote new with browser (pi)', { browser: 'chrome' });
  await profileHold('remote answer during hold, with browser (dodo loop)', {
    harness: 'dodo-loop',
    browser: 'chrome',
  });
  bworker.kill();
}
if (process.env.PROFILE_REMOTE_ONLY) {
  printMedians();
  process.exit(0);
}

// The Mac: pair a scratch Mac, run the real daemon (kept running, as launchd does).
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
  .set({ devicePairing: { code: 'profile-pair', createdAt: Date.now() } }, { merge: true });
if ((await cli('login', 'profile-pair', '--emulator', '--name', 'Profile Mac')).code !== 0)
  fail('login');
if ((await cli('folders', 'add', macFolder)).code !== 0) fail('folders add');

// A stub of the local model: answers at once, the way the fake Gemini does, and records how big
// each request is (system prompt + tools + conversation) for the prefill estimate.
const promptSizes = [];
const stub = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
  }
  const r = JSON.parse(body);
  const sys = r.messages.find((m) => m.role === 'system')?.content ?? '';
  promptSizes.push({
    chars: body.length,
    system: sys.length,
    tools: JSON.stringify(r.tools ?? []).length,
    n: r.tools?.length ?? 0,
  });
  const turns = r.messages.filter((m) => m.role === 'assistant').length;
  const lastUser = r.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const call = (name, args) => ({
    id: `c${turns}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const calls =
    /ask me/i.test(lastUser) && turns === 0
      ? [call('ask_user', { kind: 'choice', prompt: 'Stub: which option?', options: ['A', 'B'] })]
      : turns === 0
        ? [call('set_status', { text: 'Stub: reading', nextAction: 'summary' })]
        : turns === 1
          ? [
              call('update_summary', { markdown: 'Stub summary' }),
              call('post_message', { body: 'Stub done.' }),
            ]
          : [call('finish', { outcome: 'done' })];
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: calls } }],
      usage: { prompt_tokens: Math.round(body.length / 4), completion_tokens: 20 },
    }),
  );
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;
const cfgPath = path.join(macHome, 'config.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
await writeFile(
  cfgPath,
  JSON.stringify(
    { ...cfg, autoUpdate: false, localModel: { url: stubUrl, gateway: false } },
    null,
    2,
  ),
);

const daemon = spawn('node', ['apps/cli/dist/index.js', 'daemon'], {
  env: macEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(daemon);
let daemonLog = '';
daemon.stdout.on('data', (c) => (daemonLog += c));
daemon.stderr.on('data', (c) => (daemonLog += c));
await until(
  'daemon online',
  async () => (await db.doc(`devices/${cfg.deviceId}`).get()).get('version'),
  60_000,
  200,
);
const mac = `mac:${cfg.deviceId}`;

await profileNew('mac new (dodo loop)', {
  device: mac,
  folder: macFolder,
  harness: 'dodo-loop',
  browser: 'none',
});
await profileNew('mac new (pi)', { device: mac, folder: macFolder, browser: 'none' });
await profileHold('mac answer during hold (dodo loop)', {
  device: mac,
  folder: macFolder,
  harness: 'dodo-loop',
  browser: 'none',
});
await profileNew('mac new (local model)', {
  device: mac,
  folder: macFolder,
  model: 'local',
  browser: 'none',
});
await profileHold('mac answer during hold (local model)', {
  device: mac,
  folder: macFolder,
  model: 'local',
  browser: 'none',
});

// The Mac is one pair of hands: a run holding a question is released when other work queues.
{
  const holder = await newTask({
    title: 'mac release: holder',
    description: 'Please ask me a question before you start.',
    ai: { enabled: true, device: mac, folder: macFolder, harness: 'dodo-loop', browser: 'none' },
  });
  const holdRun = await until('holder run', async () => (await holder.get()).get('activeRunId'));
  await until('holder holding', async () =>
    (await db.doc(`runs/${holdRun}`).get()).get('awaiting'),
  );
  const queuedAt = Date.now();
  const other = await newTask({
    title: 'mac release: other',
    description: 'Summarise: the other task.',
    ai: { enabled: true, device: mac, folder: macFolder, harness: 'dodo-loop', browser: 'none' },
  });
  const parked = await ended(holdRun);
  if (parked.state !== 'waiting_input') fail(`holder ended ${parked.state}`);
  const otherRun = await until('other run', async () => (await other.get()).get('activeRunId'));
  await ended(otherRun);
  console.log(
    JSON.stringify({ scenario: 'mac hold released by queued work', ms: Date.now() - queuedAt }),
  );
}
daemon.kill();
stub.close();

printMedians();
console.log('\nlocal model request sizes (chars):', JSON.stringify(promptSizes.slice(0, 3)));
console.log(
  '\nsandbox:',
  /sandbox on/.test(daemonLog) ? 'on' : (/sandbox (\w+)/.exec(daemonLog)?.[1] ?? 'unknown'),
);
const lines = `${workerLog}\n${daemonLog}`.split('\n').filter((l) => /startup /.test(l));
console.log(`\nstartup lines (${lines.length}), last two:\n${lines.slice(-2).join('\n')}`);
process.exit(0);

/** Medians per scenario and phase. */
function printMedians() {
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined;
  };
  console.log('\n== medians (ms) ==');
  for (const scenario of [...new Set(results.map((r) => r.scenario))]) {
    const rows = results.filter((r) => r.scenario === scenario);
    const phases = [...new Set(rows.flatMap((r) => Object.keys(r.phases)))];
    console.log(
      `\n${scenario}: total ${median(rows.map((r) => r.total))} ms (n=${rows.length}, first ${rows[0].total} ms)`,
    );
    for (const p of phases) {
      const v = rows.map((r) => r.phases[p]).filter((x) => x !== undefined);
      console.log(`  ${p.padEnd(22)} ${String(median(v)).padStart(6)}`);
    }
  }
}
