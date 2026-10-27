import {
  isApproved,
  paths,
  type Run,
  VaultEntry,
  type VaultResolveRequest,
  VaultSaveRequest,
  vaultRule,
} from '@dodo/core';
import { hostMatches } from '@dodo/policy';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * The agent vault (ARCHITECTURE §9.2). Values are one JSON document in Secret Manager
 * (`dodo-vault`, readable only by dodo-gateway); Firestore keeps the metadata the web app and
 * the model may see. The owner can write values but never read them back; a run gets one
 * value at a time, for a site the entry allows, after you approved the entry for that task.
 */

/** entryId → field → value */
export type VaultValues = Record<string, Record<string, string>>;

export interface VaultSecretStore {
  read(): Promise<VaultValues>;
  write(values: VaultValues): Promise<void>;
}

export interface VaultDeps {
  db: Firestore;
  secrets: VaultSecretStore;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export class VaultError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'not-found' | 'permission-denied',
    message: string,
  ) {
    super(message);
  }
}

/** Every secret value is kept in one version; older versions are destroyed after a write. */
export const VAULT_SECRET = 'dodo-vault';

export async function saveVaultEntry(deps: VaultDeps, input: unknown): Promise<{ id: string }> {
  const parsed = VaultSaveRequest.safeParse(input);
  if (!parsed.success)
    throw new VaultError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid entry');
  const req = parsed.data;
  const now = (deps.now ?? Date.now)();
  const ref = deps.db.doc(paths.vaultEntry(req.id));
  const existing = await ref.get();

  const values = await deps.secrets.read();
  const before = values[req.id] ?? {};
  const after: Record<string, string> = {};
  for (const f of req.fields) {
    const v = f.value !== undefined && f.value !== '' ? f.value : before[f.key];
    if (v === undefined) throw new VaultError('invalid-argument', `${f.label} needs a value`);
    after[f.key] = v;
  }
  values[req.id] = after;
  await deps.secrets.write(values);

  await ref.set(
    {
      name: req.name,
      domains: [...new Set(req.domains)],
      hint: req.hint,
      fields: req.fields.map(({ key, label }) => ({ key, label })),
      createdAt: existing.exists ? (existing.get('createdAt') ?? now) : now,
      updatedAt: now,
    },
    { merge: true },
  );
  deps.log?.('vault entry saved', { id: req.id, fields: req.fields.map((f) => f.key) });
  return { id: req.id };
}

export async function deleteVaultEntry(deps: VaultDeps, id: string): Promise<void> {
  const values = await deps.secrets.read();
  if (id in values) {
    delete values[id];
    await deps.secrets.write(values);
  }
  await deps.db.doc(paths.vaultEntry(id)).delete();
  deps.log?.('vault entry deleted', { id });
}

/**
 * Whether you allowed this task to use the entry: an allow rule `Vault(id)` on the task itself,
 * or an approval card for that rule you answered yes on this task. Project and global rules do
 * not count, on purpose: a credential is approved per task. A deny rule anywhere wins.
 */
export async function vaultGranted(db: Firestore, run: Run, entryId: string): Promise<boolean> {
  const rule = vaultRule(entryId);
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  const [task, project, settings] = await Promise.all([
    db.doc(paths.task(run.taskId)).get(),
    run.projectId ? db.doc(paths.project(run.projectId)).get() : undefined,
    db.doc(paths.settings()).get(),
  ]);
  const denied = [task.get('denyRules'), project?.get('denyRules'), settings.get('denyRules')]
    .flatMap(list)
    .some((r) => r === rule || r === 'Vault');
  if (denied) return false;
  if (list(task.get('allowRules')).includes(rule)) return true;
  const approvals = await db
    .collection(paths.messages(run.taskId))
    .where('input.suggestedRule', '==', rule)
    .get();
  return approvals.docs.some((d) => {
    const value = d.get('input.answer.value');
    return typeof value === 'string' && isApproved(value);
  });
}

/** One value for one site, for a live run whose task you approved for this entry. */
export async function resolveVaultValue(
  deps: VaultDeps,
  run: Run,
  req: VaultResolveRequest,
): Promise<{ value: string }> {
  const snap = await deps.db.doc(paths.vaultEntry(req.entryId)).get();
  if (!snap.exists) throw new VaultError('not-found', `No vault entry ${req.entryId}`);
  const entry = VaultEntry.parse({ id: snap.id, ...snap.data() });
  const host = req.host.toLowerCase().replace(/\.$/, '');
  if (!hostMatches(host, entry.domains)) {
    deps.log?.('vault refused: wrong site', { entryId: entry.id, host, runId: run.id });
    throw new VaultError(
      'permission-denied',
      `${entry.name} may only be used on ${entry.domains.join(', ')}, not ${host}`,
    );
  }
  if (!(await vaultGranted(deps.db, run, entry.id))) {
    throw new VaultError(
      'permission-denied',
      `This task is not approved to use ${entry.name}; ask for ${vaultRule(entry.id)} first`,
    );
  }
  const value = (await deps.secrets.read())[entry.id]?.[req.field];
  if (value === undefined) throw new VaultError('not-found', `${entry.name} has no ${req.field}`);
  const now = (deps.now ?? Date.now)();
  await snap.ref.update({ lastUsed: { at: now, taskId: run.taskId, field: req.field } });
  // Never the value: only which entry, which field, for which run and site.
  deps.log?.('vault value used', { entryId: entry.id, field: req.field, runId: run.id, host });
  return { value };
}

/** Production store: Secret Manager. Each write adds a version and destroys the older ones. */
export function secretManagerStore(projectId: string): VaultSecretStore {
  const name = `projects/${projectId}/secrets/${VAULT_SECRET}`;
  // Loaded lazily so the emulator and tests never need Google credentials.
  const client = import('@google-cloud/secret-manager').then(
    (m) => new m.SecretManagerServiceClient(),
  );
  return {
    async read() {
      const sm = await client;
      try {
        const [version] = await sm.accessSecretVersion({ name: `${name}/versions/latest` });
        const raw = version.payload?.data?.toString() ?? '{}';
        return JSON.parse(raw) as VaultValues;
      } catch (err) {
        // NOT_FOUND: no version yet, an empty vault.
        if ((err as { code?: number }).code === 5) return {};
        throw err;
      }
    },
    async write(values) {
      const sm = await client;
      const [added] = await sm.addSecretVersion({
        parent: name,
        payload: { data: Buffer.from(JSON.stringify(values), 'utf8') },
      });
      const [versions] = await sm.listSecretVersions({ parent: name, filter: 'state:ENABLED' });
      await Promise.all(
        versions
          .filter((v) => v.name && v.name !== added.name)
          .map((v) => sm.destroySecretVersion({ name: v.name as string })),
      );
    },
  };
}

/** Emulator store: a server-only Firestore document (rules deny every client). */
export function firestoreDevStore(db: Firestore): VaultSecretStore {
  const ref = db.doc('vaultDev/values');
  return {
    read: async () => ((await ref.get()).get('values') as VaultValues | undefined) ?? {},
    write: async (values) => {
      await ref.set({ values });
    },
  };
}
