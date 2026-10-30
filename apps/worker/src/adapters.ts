import {
  type ControlPlane,
  GatewayBudgetError,
  GatewayHaltedError,
  GatewayRateLimitError,
  LeaseLostError,
  type TaskStore,
  type TraceSink,
} from '@dodo/agent';
import {
  Artifact,
  type EmailCodeRequest,
  EmailCodeResponse,
  type FinishRequest,
  type GenerateRequest,
  GenerateResponse,
  GitHubTokenResponse,
  type GoogleOp,
  HeartbeatResponse,
  type NotionOp,
  PersonalInfo,
  Project,
  paths,
  type RequestInputRequest,
  type RunEvent,
  type RunGoogleAccess,
  type RunNotionAccess,
  type RunToolAccess,
  SearchResponse,
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
  /** The browser worker image: start headless Chromium for runs that want a browser. */
  headlessBrowser?: boolean;
  /** Mac: the daemon's endpoints for this Mac's local MCP servers, by server id. */
  mcpUrls?: Record<string, string>;
  /** When the worker is killed (epoch ms), from DODO_TIMEOUT_S; a hold for an answer ends before it. */
  deadline?: number;
  /** Mac: the local model's OpenAI-compatible server (`dodo model`), for runs on the local model. */
  localModel?: { url: string; model?: string };
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

const READ_LIMIT = 200_000;
const TEXT_EXT =
  /\.(md|markdown|mdx|txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|[cm]?js|tsx?|jsx|py|rb|go|rs|java|sh|sql|ics|vcf|srt)$/i;

/** An uploaded file's text, through its download URL (which carries its own access token). */
export async function readStoredFile(name: string, url: string, fetchFn: typeof fetch = fetch) {
  const res = await fetchFn(url);
  if (!res.ok) return `(file) ${name}: download failed with HTTP ${res.status}.`;
  const type = res.headers.get('content-type') ?? '';
  const textual = TEXT_EXT.test(name) || type.startsWith('text/') || type.includes('json');
  if (!textual) return `(file) ${name} is ${type || 'binary'}, not text. Its download URL: ${url}`;
  const text = await res.text();
  return text.length > READ_LIMIT
    ? `${text.slice(0, READ_LIMIT)}\n\n[cut at ${READ_LIMIT} of ${text.length} characters]`
    : text;
}

/** Maps callable error codes to the typed errors the loop reacts to. */
function translate(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  const msg = e.message ?? '';
  if (code.endsWith('resource-exhausted')) {
    const rate = /^rate_governor:\s*/.exec(msg);
    return rate
      ? new GatewayRateLimitError(msg.slice(rate[0].length))
      : new GatewayBudgetError(msg);
  }
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
      contextWindow?: number;
      browser?: boolean;
      browserSetting?: 'none' | 'auto' | 'chrome';
      policy: {
        profile: 'agent-decides' | 'untrusted';
        allow: string[];
        deny: string[];
        allowedHosts: string[];
      };
      tools?: RunToolAccess;
      google?: RunGoogleAccess;
      notion?: RunNotionAccess;
    }>('runStart', { runId: this.runId });
  }
  async generate(req: Omit<GenerateRequest, 'runId'>) {
    return GenerateResponse.parse(
      await this.call('gatewayGenerate', { runId: this.runId, ...req }),
    );
  }
  /** web_search: the control plane runs it and charges the task; budget refusals end the run. */
  async search(query: string) {
    return SearchResponse.parse(await this.call('gatewaySearch', { runId: this.runId, query }));
  }
  /** A Gmail, Calendar or Drive call: the control plane runs it with the Google token. */
  async google(call: GoogleOp): Promise<Record<string, unknown>> {
    try {
      const r = await httpsCallable(this.fns, 'googleTool', { timeout: 180_000 })(
        JSON.parse(JSON.stringify({ runId: this.runId, call })),
      );
      return (r.data ?? {}) as Record<string, unknown>;
    } catch (err) {
      throw new Error((err as Error).message || `Google ${call.op} failed`);
    }
  }
  /** A Notion call: the control plane runs it with the integration token. */
  async notion(call: NotionOp): Promise<Record<string, unknown>> {
    try {
      const r = await httpsCallable(this.fns, 'notionTool', { timeout: 120_000 })(
        JSON.parse(JSON.stringify({ runId: this.runId, call })),
      );
      return (r.data ?? {}) as Record<string, unknown>;
    } catch (err) {
      throw new Error((err as Error).message || `Notion ${call.op} failed`);
    }
  }
  async heartbeat() {
    return HeartbeatResponse.parse(await this.call('runHeartbeat', { runId: this.runId }));
  }
  async requestInput(req: Omit<RequestInputRequest, 'runId'>) {
    return this.call<{ messageId?: string }>('runRequestInput', { runId: this.runId, ...req });
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
  /** A secret answer to ask_user on this run's task (an MFA code), for a browser tool to type. */
  async resolveAnswer(messageId: string): Promise<string> {
    try {
      const r = await httpsCallable(this.fns, 'runSecretAnswer', { timeout: 30_000 })({
        runId: this.runId,
        messageId,
      });
      return (r.data as { value: string }).value;
    } catch (err) {
      throw new Error((err as Error).message || 'Secret answer not available');
    }
  }
  /** The newest sign-in code a site emailed the user, for the browser tool to type. */
  async emailCode(req: Omit<EmailCodeRequest, 'runId'>): Promise<EmailCodeResponse> {
    try {
      const r = await httpsCallable(this.fns, 'runEmailCode', { timeout: 60_000 })({
        runId: this.runId,
        ...req,
      });
      return EmailCodeResponse.parse(r.data);
    } catch (err) {
      return { found: false, error: (err as Error).message || 'Email codes not available' };
    }
  }
  /** The task's remote-browser logins: `get` before the browser starts, `put` when the run ends. */
  async browserState(
    action: 'get' | 'put' | 'google-get' | 'google-put',
    put?: { state: string; lastUrl?: string },
  ): Promise<{ state?: string; lastUrl?: string }> {
    const r = await httpsCallable(this.fns, 'runBrowserState', { timeout: 60_000 })({
      runId: this.runId,
      action,
      ...(put ?? {}),
    });
    const { state, lastUrl } = r.data as { state?: string; lastUrl?: string };
    return { state, lastUrl };
  }
  /** A token for the run's own repo (docs/GITHUB.md); refusals come back as plain Errors. */
  async githubToken(access: 'read' | 'write', repo?: string): Promise<GitHubTokenResponse> {
    try {
      const r = await httpsCallable(this.fns, 'githubToken', { timeout: 30_000 })({
        runId: this.runId,
        access,
        ...(repo ? { repo } : {}),
      });
      return GitHubTokenResponse.parse(r.data);
    } catch (err) {
      throw new Error((err as Error).message || 'GitHub token not available');
    }
  }
  async githubOpenPr(req: {
    repo?: string;
    head: string;
    base?: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ url: string; number: number; existing: boolean }> {
    try {
      const r = await httpsCallable(this.fns, 'githubOpenPr', { timeout: 60_000 })(
        JSON.parse(JSON.stringify({ runId: this.runId, ...req })),
      );
      return r.data as { url: string; number: number; existing: boolean };
    } catch (err) {
      throw new Error((err as Error).message || 'Could not open the pull request');
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
    if (a.kind === 'file' && a.url) return readStoredFile(a.name, a.url);
    if (a.url) return `(link) ${a.url}\nOpen it with the browser or http tools to read it.`;
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
