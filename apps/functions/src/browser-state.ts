import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';

/**
 * Logins of the remote browser, per task (ARCHITECTURE §9.1). A run with headless Chromium
 * gets the task's stored Playwright `storageState` (cookies, local storage) when it starts
 * and hands it back when it ends, so a login survives from one run to the next for as long
 * as the site keeps the session. The blob lives in Cloud Storage under a prefix no client
 * rule allows, encrypted with a key only the gateway account can read (Secret Manager), and
 * is deleted when the task is done, cancelled or deleted. Task-level on purpose: two tasks
 * on the same site never share or overwrite a session.
 */

export interface BrowserStateDeps {
  storage: Storage;
  /** The 32-byte key; the same key for every task. */
  key: () => Promise<Buffer>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export const browserStatePath = (taskId: string) => `browser/${taskId}/state.enc`;

/** Biggest state kept: cookies and local storage for a handful of sites fit in far less. */
export const MAX_STATE_BYTES = 2_000_000;

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** iv ‖ tag ‖ ciphertext */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export interface StoredBrowserState {
  /** Playwright `storageState` as JSON. */
  state: string;
  /** Where the agent was when the run ended. */
  lastUrl?: string;
}

/** The task's stored state, or nothing. A blob that cannot be read is dropped. */
export async function loadBrowserState(
  deps: BrowserStateDeps,
  taskId: string,
): Promise<StoredBrowserState | undefined> {
  const file = deps.storage.bucket().file(browserStatePath(taskId));
  let blob: Buffer;
  try {
    [blob] = await file.download();
  } catch (err) {
    if ((err as { code?: number }).code === 404) return undefined;
    throw err;
  }
  try {
    const stored = JSON.parse(decrypt(await deps.key(), blob)) as StoredBrowserState;
    if (typeof stored.state !== 'string') throw new Error('not a stored browser state');
    return stored;
  } catch (err) {
    deps.log?.('browser state unreadable; dropped', { taskId, err: String(err) });
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return undefined;
  }
}

export async function saveBrowserState(
  deps: BrowserStateDeps,
  taskId: string,
  stored: StoredBrowserState,
): Promise<void> {
  if (Buffer.byteLength(stored.state, 'utf8') > MAX_STATE_BYTES) {
    throw new Error(`browser state over ${MAX_STATE_BYTES} bytes`);
  }
  // Nothing worth keeping: a state with no cookies and no local storage is an empty login.
  const parsed = JSON.parse(stored.state) as { cookies?: unknown[]; origins?: unknown[] };
  if (!parsed.cookies?.length && !parsed.origins?.length) {
    await deleteBrowserState(deps, taskId);
    return;
  }
  const body = JSON.stringify({ state: stored.state, lastUrl: stored.lastUrl });
  await deps.storage
    .bucket()
    .file(browserStatePath(taskId))
    .save(encrypt(await deps.key(), body), {
      contentType: 'application/octet-stream',
      resumable: false,
    });
}

export async function deleteBrowserState(
  deps: Pick<BrowserStateDeps, 'storage'>,
  taskId: string,
): Promise<void> {
  await deps.storage.bucket().file(browserStatePath(taskId)).delete({ ignoreNotFound: true });
}

/** The task was just closed (done, cancelled) or deleted. */
export function taskClosing(
  before: { status?: string } | undefined,
  after: { status?: string } | undefined,
): boolean {
  const closed = (s: string | undefined) => s === 'done' || s === 'cancelled';
  const gone = !after && !!before;
  return gone || (closed(after?.status) && !closed(before?.status));
}

/** A task that is closed or gone loses its logins. */
export async function onTaskClosed(
  deps: Pick<BrowserStateDeps, 'storage' | 'log'>,
  taskId: string,
  before: { status?: string } | undefined,
  after: { status?: string } | undefined,
): Promise<void> {
  if (!taskClosing(before, after)) return;
  await deleteBrowserState(deps, taskId).catch((err) =>
    deps.log?.('browser state delete failed', { taskId, err: String(err) }),
  );
}

/** The key secret, created by the deploy workflow like the vault's; its one version is minted here. */
export const BROWSER_KEY_SECRET = 'dodo-browser-key';

/** Production key: the latest version of the secret, minted on first use. */
export function secretManagerKey(
  projectId: string,
  secret = BROWSER_KEY_SECRET,
): () => Promise<Buffer> {
  const name = `projects/${projectId}/secrets/${secret}`;
  const client = import('@google-cloud/secret-manager').then(
    (m) => new m.SecretManagerServiceClient(),
  );
  let cached: Buffer | undefined;
  return async () => {
    if (cached) return cached;
    const sm = await client;
    const latest = async () => {
      const [version] = await sm.accessSecretVersion({ name: `${name}/versions/latest` });
      return Buffer.from(version.payload?.data?.toString() ?? '', 'base64');
    };
    try {
      cached = await latest();
    } catch (err) {
      if ((err as { code?: number }).code !== 5) throw err;
      await sm.addSecretVersion({
        parent: name,
        payload: { data: Buffer.from(randomBytes(32).toString('base64'), 'utf8') },
      });
      // Two cold starts may both mint one; the latest wins for everyone from here on.
      cached = await latest();
    }
    if (cached.length !== 32) throw new Error('browser key is not 32 bytes');
    return cached;
  };
}

/** Emulator key: a server-only Firestore document, minted on first use. */
export function firestoreDevKey(
  db: Firestore,
  path = 'vaultDev/browserKey',
): () => Promise<Buffer> {
  return async () => {
    const ref = db.doc(path);
    const existing = (await ref.get()).get('key') as string | undefined;
    if (existing) return Buffer.from(existing, 'base64');
    const key = randomBytes(32).toString('base64');
    await ref.set({ key });
    return Buffer.from(key, 'base64');
  };
}
