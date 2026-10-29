import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
let env: RulesTestEnvironment;

describe.skipIf(!enabled)('firestore.rules', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-dodo-rules',
      firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
    });
  });
  afterAll(() => env?.cleanup());
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'tasks/t1'), { title: 'x' });
      await setDoc(doc(db, 'tasks/t1/messages/m1'), {
        author: 'agent',
        body: 'q',
        input: { kind: 'text', prompt: 'q' },
      });
      await setDoc(doc(db, 'budgets/task_t1'), { reserved: 0, spent: 1 });
      await setDoc(doc(db, 'runs/r1'), {
        taskId: 't1',
        state: 'running',
        interrupt: false,
        generation: 2,
      });
      await setDoc(doc(db, 'devices/d1'), { name: 'MacBook', state: 'approved', lastSeen: 1 });
      await setDoc(doc(db, 'devices/d2'), { name: 'Old', state: 'revoked' });
      await setDoc(doc(db, 'runs/m1'), {
        taskId: 't1',
        state: 'queued',
        device: 'mac:d1',
        generation: 0,
      });
      await setDoc(doc(db, 'runs/m2'), {
        taskId: 't1',
        state: 'queued',
        device: 'mac:d2',
        generation: 0,
      });
      await setDoc(doc(db, 'runs/r9'), {
        taskId: 't1',
        state: 'succeeded',
        interrupt: false,
        generation: 1,
      });
    });
  });

  const owner = () => env.authenticatedContext('owner', { dodo_owner: true }).firestore();
  const stranger = () =>
    env.authenticatedContext('someone', { email: 'x@example.com' }).firestore();
  const anon = () => env.unauthenticatedContext().firestore();
  const run = (runId = 'r1', generation = 2, taskId = 't1') =>
    env.authenticatedContext(`run:${runId}`, { run: runId, taskId, generation }).firestore();

  it('lets only the owner read and write tasks', async () => {
    await assertSucceeds(getDoc(doc(owner(), 'tasks/t1')));
    await assertSucceeds(setDoc(doc(owner(), 'tasks/t2'), { title: 'new' }));
    await assertFails(getDoc(doc(stranger(), 'tasks/t1')));
    await assertFails(getDoc(doc(anon(), 'tasks/t1')));
    await assertFails(setDoc(doc(stranger(), 'tasks/t3'), { title: 'spam' }));
  });

  it('keeps budget state read-only for the owner', async () => {
    await assertSucceeds(getDoc(doc(owner(), 'budgets/task_t1')));
    await assertFails(setDoc(doc(owner(), 'budgets/task_t1'), { reserved: 0, spent: 0 }));
    await assertFails(setDoc(doc(owner(), 'ledger/x'), { actual: 0 }));
    await assertFails(setDoc(doc(owner(), 'reservations/x'), { amount: 0 }));
  });

  it('lets the owner post only as the user, and answer input requests', async () => {
    await assertSucceeds(
      setDoc(doc(owner(), 'tasks/t1/messages/m2'), { author: 'user', body: 'hi' }),
    );
    await assertFails(
      setDoc(doc(owner(), 'tasks/t1/messages/m3'), { author: 'agent', body: 'fake' }),
    );
    await assertSucceeds(
      updateDoc(doc(owner(), 'tasks/t1/messages/m1'), { 'input.answer': { value: 'ok' } }),
    );
    await assertFails(updateDoc(doc(owner(), 'tasks/t1/messages/m1'), { body: 'rewritten' }));
  });

  it('lets the owner only request an interrupt on runs', async () => {
    await assertSucceeds(updateDoc(doc(owner(), 'runs/r1'), { interrupt: true }));
    await assertFails(updateDoc(doc(owner(), 'runs/r1'), { state: 'succeeded' }));
    await assertFails(setDoc(doc(owner(), 'runs/r2'), { taskId: 't1' }));
  });

  it('lets a live run write its trace and its task summary, status, messages and artifacts', async () => {
    await assertSucceeds(getDoc(doc(run(), 'tasks/t1')));
    await assertSucceeds(
      updateDoc(doc(run(), 'tasks/t1'), { summary: 's', statusLine: { text: 'x' }, updatedAt: 1 }),
    );
    await assertFails(updateDoc(doc(run(), 'tasks/t1'), { title: 'renamed' }));
    await assertFails(updateDoc(doc(run(), 'tasks/t1'), { ai: { budget: 1e9 } }));
    await assertSucceeds(
      setDoc(doc(run(), 'runs/r1/events/e1'), { runId: 'r1', seq: 0, type: 'run_started' }),
    );
    await assertFails(setDoc(doc(run(), 'runs/r9/events/e1'), { runId: 'r9', seq: 0 }));
    await assertSucceeds(
      setDoc(doc(run(), 'tasks/t1/messages/m5'), { author: 'agent', runId: 'r1', body: 'hi' }),
    );
    await assertFails(
      setDoc(doc(run(), 'tasks/t1/messages/m6'), { author: 'user', runId: 'r1', body: 'spoof' }),
    );
    await assertFails(
      setDoc(doc(run(), 'tasks/t1/messages/m7'), {
        author: 'agent',
        runId: 'r1',
        body: 'q',
        input: { kind: 'text', prompt: 'q' },
      }),
    );
    await assertSucceeds(
      setDoc(doc(run(), 'tasks/t1/artifacts/a1'), { createdBy: 'agent', kind: 'text', name: 'n' }),
    );
    await assertFails(updateDoc(doc(run(), 'runs/r1'), { state: 'succeeded' }));
    await assertFails(updateDoc(doc(run(), 'runs/r1'), { interrupt: true }));
    await assertFails(getDoc(doc(run(), 'settings/global')));
    await assertFails(getDoc(doc(run(), 'budgets/task_t1')));
  });

  it('rejects a run whose lease generation is stale, ended, or on another task', async () => {
    await assertFails(updateDoc(doc(run('r1', 1), 'tasks/t1'), { summary: 'stale' }));
    await assertFails(setDoc(doc(run('r1', 1), 'runs/r1/events/e2'), { runId: 'r1', seq: 1 }));
    await assertFails(updateDoc(doc(run('r9', 1), 'tasks/t1'), { summary: 'ended' }));
    await assertFails(updateDoc(doc(run('r1', 2, 't2'), 'tasks/t1'), { summary: 'other task' }));
    await assertFails(getDoc(doc(run('r1', 2, 't2'), 'tasks/t1')));
  });

  it('keeps push tokens to the owner', async () => {
    await assertSucceeds(setDoc(doc(owner(), 'pushTokens/tok1'), { createdAt: 1 }));
    await assertSucceeds(getDoc(doc(owner(), 'pushTokens/tok1')));
    await assertFails(getDoc(doc(stranger(), 'pushTokens/tok1')));
    await assertFails(setDoc(doc(stranger(), 'pushTokens/tok2'), { createdAt: 1 }));
    await assertFails(getDoc(doc(run(), 'pushTokens/tok1')));
  });

  it('lets the owner list and revoke API tokens, but not create or un-revoke them', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'apiTokens/h1'), { name: 'x', hash: 'h1', revoked: false });
      await setDoc(doc(ctx.firestore(), 'ingestKeys/k1'), { taskId: 't1' });
    });
    await assertSucceeds(getDoc(doc(owner(), 'apiTokens/h1')));
    await assertFails(setDoc(doc(owner(), 'apiTokens/h2'), { name: 'forged', hash: 'h2' }));
    await assertFails(updateDoc(doc(owner(), 'apiTokens/h1'), { name: 'renamed' }));
    await assertSucceeds(updateDoc(doc(owner(), 'apiTokens/h1'), { revoked: true }));
    await assertFails(updateDoc(doc(owner(), 'apiTokens/h1'), { revoked: false }));
    await assertFails(getDoc(doc(stranger(), 'apiTokens/h1')));
    await assertFails(getDoc(doc(run(), 'apiTokens/h1')));
    await assertFails(getDoc(doc(owner(), 'ingestKeys/k1')));
  });

  it('lets the owner configure jobs but not write their state, ledgers or secrets', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'jobs/gmail-followup'), { kind: 'gmail-followup', enabled: false });
      await setDoc(doc(db, 'jobs/gmail-followup/items/m1'), { state: 'done' });
      await setDoc(doc(db, 'jobRuns/r1'), { jobId: 'gmail-followup' });
      await setDoc(doc(db, 'connectors/google'), { status: 'connected' });
      await setDoc(doc(db, 'connectorSecrets/google'), { refreshToken: 'x' });
    });
    await assertSucceeds(
      updateDoc(doc(owner(), 'jobs/gmail-followup'), {
        enabled: true,
        config: { lookbackDays: 2 },
      }),
    );
    await assertFails(
      updateDoc(doc(owner(), 'jobs/gmail-followup'), { 'state.consecutiveFailures': 0 }),
    );
    await assertSucceeds(
      setDoc(doc(owner(), 'jobs/whatsapp-followup'), { kind: 'whatsapp-followup', enabled: false }),
    );
    await assertFails(
      setDoc(doc(owner(), 'jobs/other'), { kind: 'gmail-followup', state: { lock: null } }),
    );
    await assertSucceeds(getDoc(doc(owner(), 'jobs/gmail-followup/items/m1')));
    await assertFails(setDoc(doc(owner(), 'jobs/gmail-followup/items/m2'), { state: 'done' }));
    await assertSucceeds(getDoc(doc(owner(), 'jobRuns/r1')));
    await assertSucceeds(getDoc(doc(owner(), 'connectors/google')));
    await assertFails(setDoc(doc(owner(), 'connectors/google'), { status: 'connected' }));
    await assertFails(getDoc(doc(owner(), 'connectorSecrets/google')));
    await assertFails(getDoc(doc(stranger(), 'jobs/gmail-followup')));
    await assertFails(getDoc(doc(run(), 'jobRuns/r1')));
  });

  const device = (id = 'd1') =>
    env.authenticatedContext(`device:${id}`, { device: id }).firestore();

  it('lets a Mac read and heartbeat only its own device document', async () => {
    await assertSucceeds(getDoc(doc(device(), 'devices/d1')));
    await assertSucceeds(
      updateDoc(doc(device(), 'devices/d1'), { lastSeen: 2, folders: ['~/code'], browser: true }),
    );
    await assertFails(updateDoc(doc(device(), 'devices/d1'), { name: 'renamed' }));
    await assertFails(updateDoc(doc(device(), 'devices/d1'), { state: 'revoked', lastSeen: 3 }));
    await assertFails(getDoc(doc(device(), 'devices/d2')));
    await assertFails(updateDoc(doc(device('d2'), 'devices/d2'), { lastSeen: 2 }));
    await assertFails(getDoc(doc(device(), 'tasks/t1')));
    await assertFails(getDoc(doc(device(), 'settings/global')));
    await assertFails(getDoc(doc(device(), 'pushTokens/tok1')));
    await assertFails(getDoc(doc(stranger(), 'devices/d1')));
  });

  it('lets a Mac see only the runs addressed to it, and never write them', async () => {
    await assertSucceeds(getDoc(doc(device(), 'runs/m1')));
    await assertSucceeds(
      getDocs(
        query(
          collection(device(), 'runs'),
          where('device', '==', 'mac:d1'),
          where('state', '==', 'queued'),
        ),
      ),
    );
    await assertFails(getDocs(query(collection(device(), 'runs'), where('state', '==', 'queued'))));
    await assertFails(getDoc(doc(device(), 'runs/r1')));
    await assertFails(getDoc(doc(device('d2'), 'runs/m2'))); // revoked
    await assertFails(updateDoc(doc(device(), 'runs/m1'), { state: 'claimed' }));
    await assertFails(getDoc(doc(device(), 'runs/m1/events/e1')));
  });

  it('lets the owner edit personal info and a live run read it', async () => {
    await assertSucceeds(setDoc(doc(owner(), 'settings/profile'), { email: 'a@b.be' }));
    await assertSucceeds(getDoc(doc(run(), 'settings/profile')));
    await assertFails(getDoc(doc(run('r9', 1), 'settings/profile'))); // finished run
    await assertFails(setDoc(doc(run(), 'settings/profile'), { email: 'x@evil.com' }));
    await assertFails(getDoc(doc(stranger(), 'settings/profile')));
    await assertFails(getDoc(doc(run(), 'settings/global')));
  });

  it('keeps vault metadata read-only and vault values out of every client', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'vault/energy'), { name: 'Energy', domains: ['x.be'] });
      await setDoc(doc(ctx.firestore(), 'vaultDev/values'), { values: { energy: { p: 's' } } });
    });
    await assertSucceeds(getDoc(doc(owner(), 'vault/energy')));
    await assertSucceeds(getDoc(doc(run(), 'vault/energy')));
    await assertFails(getDoc(doc(run('r9', 1), 'vault/energy')));
    await assertFails(setDoc(doc(owner(), 'vault/energy'), { name: 'changed' }));
    await assertFails(setDoc(doc(run(), 'vault/new'), { name: 'x' }));
    await assertFails(getDoc(doc(stranger(), 'vault/energy')));
    await assertFails(getDoc(doc(owner(), 'vaultDev/values')));
    await assertFails(getDoc(doc(run(), 'vaultDev/values')));
  });

  it('shows the GitHub connection to the owner only and keeps its key server-side', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'github/app'), { repos: [] });
      await setDoc(doc(ctx.firestore(), 'githubDev/app'), { values: { app: { pem: 'k' } } });
    });
    await assertSucceeds(getDoc(doc(owner(), 'github/app')));
    await assertFails(setDoc(doc(owner(), 'github/app'), { repos: [] }));
    await assertFails(getDoc(doc(run(), 'github/app')));
    await assertFails(getDoc(doc(stranger(), 'github/app')));
    await assertFails(getDoc(doc(owner(), 'githubDev/app')));
  });

  it('lets a Mac list its own local MCP servers and their tools, not turn them on', async () => {
    const local = {
      name: 'Outlook',
      slug: 'outlook',
      runsOn: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['outlook-mcp'],
      deviceId: 'd1',
      enabled: true,
      disabledTools: [],
      createdAt: 1,
      updatedAt: 1,
    };
    await assertSucceeds(setDoc(doc(device(), 'mcpServers/d1-outlook'), local));
    await assertSucceeds(getDoc(doc(device(), 'mcpServers/d1-outlook')));
    await assertSucceeds(
      getDocs(query(collection(device(), 'mcpServers'), where('deviceId', '==', 'd1'))),
    );
    await assertSucceeds(
      updateDoc(doc(device(), 'mcpServers/d1-outlook'), {
        catalog: { tools: [], fetchedAt: 2, by: 'mac:d1' },
        updatedAt: 2,
      }),
    );
    await assertFails(updateDoc(doc(device(), 'mcpServers/d1-outlook'), { disabledTools: ['x'] }));
    // Not under another Mac's name, not as a remote server, not for a revoked Mac.
    await assertFails(setDoc(doc(device(), 'mcpServers/d2-outlook'), { ...local, deviceId: 'd2' }));
    await assertFails(setDoc(doc(device(), 'mcpServers/d1-x'), { ...local, runsOn: 'remote' }));
    await assertFails(
      setDoc(doc(device('d2'), 'mcpServers/d2-outlook'), { ...local, deviceId: 'd2' }),
    );
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'mcpServers/linear'), {
        slug: 'linear',
        runsOn: 'remote',
        url: 'https://mcp.linear.app/mcp',
      });
    });
    await assertFails(getDoc(doc(device(), 'mcpServers/linear')));
    await assertFails(getDoc(doc(run(), 'mcpServers/linear')));
    await assertSucceeds(updateDoc(doc(owner(), 'mcpServers/d1-outlook'), { enabled: false }));
    await assertSucceeds(setDoc(doc(owner(), 'toolsets/mail'), { name: 'Mail', tools: [] }));
    await assertSucceeds(setDoc(doc(owner(), 'settings/tools'), { disabledBuiltins: ['bash'] }));
    await assertFails(getDoc(doc(run(), 'toolsets/mail')));
    await assertFails(getDoc(doc(stranger(), 'settings/tools')));
  });

  it('denies unknown collections', async () => {
    await assertFails(setDoc(doc(owner(), 'anything/x'), { a: 1 }));
  });
});
