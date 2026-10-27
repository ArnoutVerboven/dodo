import {
  type ControlPlane,
  GatewayBudgetError,
  GatewayHaltedError,
  LeaseLostError,
  type TaskStore,
  type TraceSink,
} from '@dodo/agent';
import {
  Artifact,
  type FinishRequest,
  type GenerateRequest,
  GenerateResponse,
  HeartbeatResponse,
  PersonalInfo,
  Project,
  paths,
  type RequestInputRequest,
  type RunEvent,
  type StatusLine,
  Task,
  VaultEntry,
} from '@dodo/core';
import type { FirebaseApp } from 'firebase/app';
import { type Auth, connectAuthEmulator, getAuth, signInWithCustomToken } from 'firebase/auth';
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  doc,
  type Firestore,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore';
import {
  connectFunctionsEmulator,
  type Functions,
  getFunctions,
  httpsCallable,
} from 'firebase/functions';

export interface WorkerEnv {
  runId: string;
  runToken: string;
  firebase: { apiKey: string; projectId: string; appId?: string };
  region: string;
  /** Host of the Firebase emulators, when running locally. */
  emulatorHost?: string;
  /** Mac daemon: where scratch task folders go, and the folders a task may name as its own. */
  workRoot?: string;
  allowedFolders?: string[];
  /** Playwright MCP endpoint for the browser tools (the daemon's server on your Chrome). */
  browserUrl?: string;
}

export interface Clients {
  auth: Auth;
  db: Firestore;
  functions: Functions;
}

export function connect(app: FirebaseApp, env: WorkerEnv): Clients {
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, env.region);
  if (env.emulatorHost) {
    connectAuthEmulator(auth, `http://${env.emulatorHost}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, env.emulatorHost, 8080);
    connectFunctionsEmulator(functions, env.emulatorHost, 5001);
  }
  return { auth, db, functions };
}

export async function signInAsRun(clients: Clients, token: string) {
  await signInWithCustomToken(clients.auth, token);
}

/** Maps callable error codes to the typed errors the loop reacts to. */
function translate(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  const msg = e.message ?? '';
  if (code.endsWith('resource-exhausted')) return new GatewayBudgetError(msg);
  if (code.endsWith('unavailable') && /halted/.test(msg)) return new GatewayHaltedError(msg);
  if (code.endsWith('failed-precondition')) return new LeaseLostError(msg);
  if (code.endsWith('permission-denied')) return new LeaseLostError(msg);
  return err instanceof Error ? err : new Error(String(err));
}

export class CallableControlPlane implements ControlPlane {
  constructor(
    private readonly fns: Functions,
    private readonly runId: string,
  ) {}
  private async call<T>(name: string, data: unknown): Promise<T> {
    try {
      // The callable encoder turns undefined into null; drop those keys first.
      const r = await httpsCallable(this.fns, name, { timeout: 300_000 })(
        JSON.parse(JSON.stringify(data)),
      );
      return r.data as T;
    } catch (err) {
      throw translate(err);
    }
  }
  async start() {
    return this.call<{
      task: Record<string, unknown>;
      project?: Record<string, unknown>;
      session: GenerateRequest['contents'];
      answer?: { prompt: string; value: string; suggestedRule?: string; alwaysAllow?: boolean };
      trigger: 'new' | 'comment' | 'resume';
      model: string;
      policy: {
        profile: 'agent-decides' | 'untrusted';
        allow: string[];
        deny: string[];
        allowedHosts: string[];
      };
    }>('runStart', { runId: this.runId });
  }
  async generate(req: Omit<GenerateRequest, 'runId'>) {
    return GenerateResponse.parse(
      await this.call('gatewayGenerate', { runId: this.runId, ...req }),
    );
  }
  async heartbeat() {
    return HeartbeatResponse.parse(await this.call('runHeartbeat', { runId: this.runId }));
  }
  async requestInput(req: Omit<RequestInputRequest, 'runId'>) {
    await this.call('runRequestInput', { runId: this.runId, ...req });
  }
  async finish(req: Omit<FinishRequest, 'runId'>) {
    await this.call('runFinish', { runId: this.runId, ...req });
  }
  /**
   * One vault value for the site a tool types it into. A refusal (not approved for this task,
   * wrong site) comes back as a plain Error with the reason, for the model to read; a lost
   * lease shows up at the next heartbeat.
   */
  async resolveVault(entryId: string, field: string, host: string): Promise<string> {
    try {
      const r = await httpsCallable(this.fns, 'vaultResolve', { timeout: 30_000 })({
        runId: this.runId,
        entryId,
        field,
        host,
      });
      return (r.data as { value: string }).value;
    } catch (err) {
      throw new Error((err as Error).message || 'Vault value not available');
    }
  }
}

/** Task-level reads and writes with the run's own identity, scoped by Firestore rules. */
export class FirestoreTaskStore implements TaskStore {
  constructor(
    private readonly db: Firestore,
    private readonly taskId: string,
    private readonly runId: string,
    private readonly projectId?: string,
  ) {}
  async getTask() {
    const snap = await getDoc(doc(this.db, paths.task(this.taskId)));
    return Task.parse({ id: snap.id, ...snap.data() });
  }
  async getProject() {
    if (!this.projectId) return undefined;
    const snap = await getDoc(doc(this.db, paths.project(this.projectId)));
    return snap.exists() ? Project.parse({ id: snap.id, ...snap.data() }) : undefined;
  }
  async updateSummary(markdown: string) {
    await updateDoc(doc(this.db, paths.task(this.taskId)), {
      summary: markdown,
      updatedAt: Date.now(),
    });
  }
  async setStatus(line: StatusLine) {
    await updateDoc(doc(this.db, paths.task(this.taskId)), {
      statusLine: JSON.parse(JSON.stringify(line)),
      updatedAt: Date.now(),
    });
  }
  async postMessage(body: string) {
    await addDoc(collection(this.db, paths.messages(this.taskId)), {
      author: 'agent',
      body,
      runId: this.runId,
      createdAt: Date.now(),
    });
  }
  async listArtifacts() {
    const snap = await getDocs(
      query(collection(this.db, paths.artifacts(this.taskId)), orderBy('createdAt')),
    );
    return snap.docs.flatMap((d) => {
      const p = Artifact.safeParse({ id: d.id, ...d.data() });
      return p.success ? [p.data] : [];
    });
  }
  async readArtifact(id: string) {
    const snap = await getDoc(doc(this.db, paths.artifacts(this.taskId), id));
    if (!snap.exists()) throw new Error(`No artifact ${id}`);
    const a = Artifact.parse({ id: snap.id, ...snap.data() });
    if (a.text) return a.text;
    if (a.url)
      return `(${a.kind}) ${a.url}\nReading file and link contents arrives with the browser/http tools in a later phase.`;
    return '';
  }
  async addArtifact(a: { kind: 'link' | 'text'; name: string; url?: string; text?: string }) {
    const ref = await addDoc(collection(this.db, paths.artifacts(this.taskId)), {
      ...JSON.parse(JSON.stringify(a)),
      role: 'output',
      createdBy: 'agent',
      createdAt: Date.now(),
    });
    return ref.id;
  }
  async getPersonalInfo() {
    const snap = await getDoc(doc(this.db, paths.profile()));
    if (!snap.exists()) return undefined;
    const p = PersonalInfo.safeParse(snap.data());
    return p.success ? p.data : undefined;
  }
  async listVault() {
    const snap = await getDocs(collection(this.db, paths.vault()));
    return snap.docs.flatMap((d) => {
      const p = VaultEntry.safeParse({ id: d.id, ...d.data() });
      return p.success ? [p.data] : [];
    });
  }
  async recentMessages(max: number) {
    const snap = await getDocs(
      query(
        collection(this.db, paths.messages(this.taskId)),
        orderBy('createdAt', 'desc'),
        limit(max),
      ),
    );
    return snap.docs
      .map((d) => ({
        author: d.get('author') as string,
        body: d.get('body') as string,
        createdAt: d.get('createdAt') as number,
      }))
      .reverse();
  }
}

export class FirestoreTrace implements TraceSink {
  private seq = 0;
  constructor(
    private readonly db: Firestore,
    private readonly runId: string,
  ) {}
  async emit(event: Omit<RunEvent, 'id' | 'runId' | 'seq' | 'createdAt'>) {
    const e = { ...event, runId: this.runId, seq: this.seq++, createdAt: Date.now() };
    try {
      await addDoc(collection(this.db, paths.runEvents(this.runId)), JSON.parse(JSON.stringify(e)));
    } catch (err) {
      // A trace write must never stop the run (for example right after the lease was lost).
      console.warn('trace write failed', String(err));
    }
  }
}
