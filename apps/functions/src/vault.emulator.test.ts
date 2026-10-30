import { randomUUID } from 'node:crypto';
import type { Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { checkedVaultCard } from './run-control.js';
import {
  deleteVaultEntry,
  resolveVaultValue,
  saveVaultEntry,
  taskGranted,
  type VaultDeps,
  type VaultValues,
} from './vault.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'vault-test') : undefined;
const db = app ? getFirestore(app) : undefined;

function memoryStore() {
  let values: VaultValues = {};
  let writes = 0;
  return {
    read: async () => structuredClone(values),
    write: async (v: VaultValues) => {
      values = structuredClone(v);
      writes++;
    },
    get values() {
      return values;
    },
    get writes() {
      return writes;
    },
  };
}

const id = () => `e${randomUUID().slice(0, 8)}`;

describe.skipIf(!enabled)('vault (emulator)', () => {
  afterAll(async () => app && deleteApp(app));

  const setup = async () => {
    if (!db) throw new Error('no db');
    const secrets = memoryStore();
    const deps: VaultDeps = { db, secrets };
    const entryId = id();
    const taskId = randomUUID();
    await db.doc(`tasks/${taskId}`).set({ title: 'Download the energy invoice' });
    await saveVaultEntry(deps, {
      id: entryId,
      name: 'Energy provider',
      domains: ['engie.be', 'itsme-id.com'],
      hint: 'Log in with itsme',
      fields: [
        { key: 'phone', label: 'itsme phone number', value: '+32470000000' },
        { key: 'password', label: 'Password', value: 's3cret!' },
      ],
    });
    const run = { id: `r${taskId.slice(0, 6)}`, taskId } as Run;
    return { deps, secrets, entryId, taskId, run };
  };

  it('keeps values out of Firestore and keeps a value when it is not re-entered', async () => {
    const { deps, secrets, entryId } = await setup();
    const meta = (await db?.doc(`vault/${entryId}`).get())?.data();
    expect(JSON.stringify(meta)).not.toContain('s3cret');
    expect(meta).toMatchObject({ name: 'Energy provider', domains: ['engie.be', 'itsme-id.com'] });
    await saveVaultEntry(deps, {
      id: entryId,
      name: 'Energy',
      domains: ['engie.be'],
      fields: [
        { key: 'phone', label: 'Phone' },
        { key: 'password', label: 'Password', value: 'new-pass' },
      ],
    });
    expect(secrets.values[entryId]).toEqual({ phone: '+32470000000', password: 'new-pass' });
    await expect(
      saveVaultEntry(deps, {
        id: entryId,
        name: 'Energy',
        domains: ['engie.be'],
        fields: [{ key: 'pin', label: 'PIN' }],
      }),
    ).rejects.toThrow('PIN needs a value');
  });

  it('refuses a value until the task is approved, then only for the entry sites', async () => {
    const { deps, entryId, taskId, run } = await setup();
    const req = { runId: run.id, entryId, field: 'password', host: 'www.engie.be' };
    await expect(resolveVaultValue(deps, run, req)).rejects.toThrow('not approved');

    // A "yes" to a question that is not an approval, or a "no" that starts with a y, is no grant.
    for (const input of [
      { kind: 'text', answer: { value: 'yes', answeredAt: 1 } },
      { kind: 'approval', answer: { value: 'you may not', answeredAt: 1 } },
    ])
      await db?.collection(`tasks/${taskId}/messages`).add({
        author: 'agent',
        body: 'q',
        input: { prompt: 'Continue?', suggestedRule: `Vault(${entryId})`, ...input },
      });
    await expect(resolveVaultValue(deps, run, req)).rejects.toThrow('not approved');

    await db?.collection(`tasks/${taskId}/messages`).add({
      author: 'agent',
      body: 'q',
      input: {
        kind: 'approval',
        prompt: 'Use the vault?',
        suggestedRule: `Vault(${entryId})`,
        answer: { value: 'approve', answeredAt: 1 },
      },
    });
    await expect(resolveVaultValue(deps, run, req)).resolves.toEqual({ value: 's3cret!' });
    await expect(
      resolveVaultValue(deps, run, { ...req, host: 'engie.be.evil.com' }),
    ).rejects.toThrow('may only be used on');
    const meta = (await db?.doc(`vault/${entryId}`).get())?.data();
    expect(meta?.lastUsed).toMatchObject({ taskId, field: 'password' });

    // Another task is not approved by this one's answer.
    const other = { ...run, taskId: randomUUID() };
    await db?.doc(`tasks/${other.taskId}`).set({ title: 'other' });
    await expect(resolveVaultValue(deps, other, req)).rejects.toThrow('not approved');
  });

  it('honours a task allow rule, ignores a global one, and lets a deny rule win', async () => {
    const { deps, entryId, taskId, run } = await setup();
    const req = { runId: run.id, entryId, field: 'phone', host: 'itsme-id.com' };
    await db?.doc('settings/global').set({ allowRules: [`Vault(${entryId})`] }, { merge: true });
    await expect(resolveVaultValue(deps, run, req)).rejects.toThrow('not approved');
    await db?.doc(`tasks/${taskId}`).set({ allowRules: [`Vault(${entryId})`] }, { merge: true });
    await expect(resolveVaultValue(deps, run, req)).resolves.toEqual({ value: '+32470000000' });
    await db?.doc(`tasks/${taskId}`).set({ denyRules: [`Vault(${entryId})`] }, { merge: true });
    await expect(resolveVaultValue(deps, run, req)).rejects.toThrow('not approved');
  });

  it('writes the entry and its sites into any card that would grant it', async () => {
    const { entryId } = await setup();
    if (!db) throw new Error('no db');
    const card = { kind: 'approval' as const, session: [], suggestedRule: `Vault(${entryId})` };
    const head =
      'Use your vault entry "Energy provider" (itsme phone number, password) on engie.be, itsme-id.com for this task?';
    // A card the agent dressed up as something harmless says what it really grants.
    await expect(
      checkedVaultCard(db, { ...card, prompt: 'Shall I download the invoice?' }),
    ).resolves.toMatchObject({ prompt: `${head} Shall I download the invoice?` });
    await expect(
      checkedVaultCard(db, { ...card, prompt: `${head} To log in.` }),
    ).resolves.toMatchObject({ prompt: `${head} To log in.` });
    for (const bad of [
      { ...card, kind: 'text' as const, prompt: 'Code?' },
      { ...card, suggestedRule: 'Vault(nope)', prompt: 'x' },
      { ...card, suggestedRule: 'Vault', prompt: 'x' },
      { ...card, suggestedRule: `Vault(${entryId}) `, prompt: 'x' },
    ])
      await expect(checkedVaultCard(db, bad)).rejects.toThrow('request_vault_access');
    const other = { ...card, suggestedRule: 'Bash(git push:*)', prompt: 'Push?' };
    await expect(checkedVaultCard(db, other)).resolves.toBe(other);
  });

  it('grants the Google session per task, from a checked approval card only', async () => {
    const { taskId, run } = await setup();
    if (!db) throw new Error('no db');
    const rule = 'GoogleSession(use)';
    const granted = () => taskGranted(db as NonNullable<typeof db>, run, rule, 'GoogleSession');
    expect(await granted()).toBe(false);
    const card = await checkedVaultCard(db, {
      kind: 'approval',
      session: [],
      suggestedRule: rule,
      prompt: 'Continue?',
    });
    expect(card.prompt).toMatch(/^Let this task use your saved Google sign-in\? .*Continue\?$/);
    await expect(
      checkedVaultCard(db, {
        kind: 'approval',
        session: [],
        suggestedRule: 'GoogleSession(*)',
        prompt: 'x',
      }),
    ).rejects.toThrow('use_google_session');
    await db.collection(`tasks/${taskId}/messages`).add({
      author: 'agent',
      body: card.prompt,
      input: {
        kind: 'approval',
        prompt: card.prompt,
        suggestedRule: rule,
        answer: { value: 'yes' },
      },
    });
    expect(await granted()).toBe(true);
    // Another task still asks.
    expect(await taskGranted(db, { ...run, taskId: randomUUID() }, rule, 'GoogleSession')).toBe(
      false,
    );
  });

  it('deletes values together with the entry', async () => {
    const { deps, secrets, entryId } = await setup();
    await deleteVaultEntry(deps, entryId);
    expect(secrets.values[entryId]).toBeUndefined();
    expect((await db?.doc(`vault/${entryId}`).get())?.exists).toBe(false);
  });
});
