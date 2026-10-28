import {
  ApiToken,
  Artifact,
  Device,
  eur,
  GitHubConnection,
  GlobalSettings,
  type NewTask,
  PersonalInfo,
  Project,
  paths,
  Run,
  RunEvent,
  Task,
  type TaskStatus,
  ThreadMessage,
  VaultEntry,
  type VaultSaveRequest,
} from '@dodo/core';
import {
  addDoc,
  arrayRemove,
  collection,
  deleteDoc,
  deleteField,
  doc,
  type DocumentData,
  limit,
  onSnapshot,
  orderBy,
  type Query,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { db, functions, storage } from './firebase';
import { isTextual } from './files';

export interface Live<T> {
  data: T;
  loading: boolean;
  error?: Error;
}

/** Subscribe to a query and validate each document; invalid documents are skipped and logged. */
export function useLiveQuery<S extends z.ZodTypeAny>(
  q: Query<DocumentData> | null,
  schema: S,
  deps: unknown[],
): Live<z.infer<S>[]> {
  const [state, setState] = useState<Live<z.infer<S>[]>>({ data: [], loading: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass explicit deps
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false });
      return;
    }
    return onSnapshot(
      q,
      (snap) => {
        const data: z.infer<S>[] = [];
        for (const d of snap.docs) {
          const parsed = schema.safeParse({ id: d.id, ...d.data() });
          if (parsed.success) data.push(parsed.data);
          else console.warn(`Skipping invalid document ${d.ref.path}`, parsed.error.issues);
        }
        setState({ data, loading: false });
      },
      (error) => setState({ data: [], loading: false, error }),
    );
  }, deps);
  return state;
}

export function useLiveDoc<S extends z.ZodTypeAny>(path: string | null, schema: S): Live<z.infer<S> | undefined> {
  const [state, setState] = useState<Live<z.infer<S> | undefined>>({ data: undefined, loading: true });
  useEffect(() => {
    if (!path) return;
    return onSnapshot(
      doc(db, path),
      (snap) => {
        if (!snap.exists()) return setState({ data: undefined, loading: false });
        const parsed = schema.safeParse({ id: snap.id, ...snap.data() });
        setState(
          parsed.success
            ? { data: parsed.data, loading: false }
            : { data: undefined, loading: false, error: new Error(parsed.error.message) },
        );
      },
      (error) => setState({ data: undefined, loading: false, error }),
    );
  }, [path, schema]);
  return state;
}

export const useTasks = () =>
  useLiveQuery(query(collection(db, paths.tasks()), orderBy('updatedAt', 'desc')), Task, []);

export const useTask = (id: string | undefined) => useLiveDoc(id ? paths.task(id) : null, Task);

export const useMessages = (taskId: string) =>
  useLiveQuery(
    query(collection(db, paths.messages(taskId)), orderBy('createdAt', 'asc')),
    ThreadMessage,
    [taskId],
  );

export const useArtifacts = (taskId: string) =>
  useLiveQuery(
    query(collection(db, paths.artifacts(taskId)), orderBy('createdAt', 'asc')),
    Artifact,
    [taskId],
  );

export const useRuns = (taskId: string) =>
  useLiveQuery(
    query(collection(db, paths.runs()), where('taskId', '==', taskId), orderBy('createdAt', 'desc'), limit(20)),
    Run,
    [taskId],
  );

export const useRunEvents = (runId: string) =>
  useLiveQuery(query(collection(db, paths.runEvents(runId)), orderBy('seq', 'asc')), RunEvent, [runId]);

/** The only write the owner may make on a run: ask it to stop at the next step. */
export async function interruptRun(runId: string) {
  await updateDoc(doc(db, paths.run(runId)), { interrupt: true });
}

export const useDevices = () =>
  useLiveQuery(query(collection(db, paths.devices()), orderBy('createdAt', 'asc')), Device, []);

export async function saveDevice(id: string, changes: Partial<Pick<Device, 'name' | 'state'>>) {
  await updateDoc(doc(db, paths.device(id)), clean({ ...changes, updatedAt: Date.now() }));
}

export async function removeDevice(id: string) {
  await deleteDoc(doc(db, paths.device(id)));
}

export const useApiTokens = () =>
  useLiveQuery(query(collection(db, paths.apiTokens()), orderBy('createdAt', 'desc')), ApiToken, []);

/** The token is returned once by the function; only its hash is stored. */
export async function createApiToken(
  name: string,
  source: ApiToken['source'],
): Promise<{ id: string; token: string }> {
  const res = await httpsCallable<unknown, { id: string; token: string }>(
    functions,
    'apiTokenCreate',
  )({ name, source });
  return res.data;
}

export async function revokeApiToken(id: string) {
  await updateDoc(doc(db, paths.apiToken(id)), { revoked: true });
}

export async function deleteApiToken(id: string) {
  await deleteDoc(doc(db, paths.apiToken(id)));
}

export const useProjects = () =>
  useLiveQuery(query(collection(db, paths.projects()), orderBy('name')), Project, []);

const SettingsDoc = GlobalSettings.extend({});
const DEFAULT_SETTINGS = GlobalSettings.parse({});
export function useSettings(): Live<GlobalSettings> {
  const live = useLiveDoc(paths.settings(), SettingsDoc);
  return { ...live, data: live.data ?? DEFAULT_SETTINGS };
}

export interface BudgetRow {
  id: string;
  limit: number | null;
  reserved: number;
  spent: number;
}
export function useBudgets(): Live<BudgetRow[]> {
  const [state, setState] = useState<Live<BudgetRow[]>>({ data: [], loading: true });
  useEffect(
    () =>
      onSnapshot(
        collection(db, paths.budgets()),
        (snap) =>
          setState({
            loading: false,
            data: snap.docs.map((d) => ({
              id: d.id,
              limit: d.get('limit') ?? null,
              reserved: d.get('reserved') ?? 0,
              spent: d.get('spent') ?? 0,
            })),
          }),
        (error) => setState({ data: [], loading: false, error }),
      ),
    [],
  );
  return state;
}

export interface LedgerRow {
  id: string;
  category: string;
  actual: number;
  description: string;
  taskId?: string;
  projectId?: string;
  model?: string;
  createdAt: number;
}
export function useLedger(taskId?: string, max = 200): Live<LedgerRow[]> {
  const [state, setState] = useState<Live<LedgerRow[]>>({ data: [], loading: true });
  useEffect(() => {
    const base = collection(db, paths.ledger());
    const q = taskId
      ? query(base, where('taskId', '==', taskId), orderBy('createdAt', 'desc'), limit(max))
      : query(base, orderBy('createdAt', 'desc'), limit(max));
    return onSnapshot(
      q,
      (snap) =>
        setState({ loading: false, data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as LedgerRow) }),
      (error) => setState({ data: [], loading: false, error }),
    );
  }, [taskId, max]);
  return state;
}

/** Firestore rejects `undefined` values, so drop them before writing. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function createTask(input: NewTask): Promise<string> {
  const now = Date.now();
  const title = input.title?.trim();
  const task: Omit<Task, 'id'> = {
    title: title || provisionalTitle(input.description ?? ''),
    // Until the AI title step exists (phase 2), a missing title is derived from the description.
    titleSource: title ? 'user' : 'ai',
    description: input.description ?? '',
    status: 'todo',
    priority: input.priority ?? 'none',
    dueDate: input.dueDate || undefined,
    tags: input.tags ?? [],
    projectId: input.projectId || undefined,
    ai: { ...input.ai, enabled: input.ai?.enabled ?? false },
    summary: '',
    externalRefs: {},
    createdAt: now,
    updatedAt: now,
  };
  const created = await addDoc(collection(db, paths.tasks()), clean(task));
  return created.id;
}

function provisionalTitle(description: string): string {
  const first = description.trim().split(/\n|(?<=[.!?])\s/)[0] ?? '';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first || 'Untitled task';
}

export async function updateTask(id: string, changes: Partial<Omit<Task, 'id'>>) {
  await updateDoc(doc(db, paths.task(id)), clean({ ...changes, updatedAt: Date.now() }));
}

export const setTaskStatus = (id: string, status: TaskStatus) => updateTask(id, { status });

export async function deleteTask(id: string) {
  await deleteDoc(doc(db, paths.task(id)));
}

export async function postUserMessage(taskId: string, body: string) {
  const now = Date.now();
  await addDoc(collection(db, paths.messages(taskId)), { author: 'user', body, createdAt: now });
  await updateDoc(doc(db, paths.task(taskId)), { updatedAt: now });
}

export async function answerInput(
  taskId: string,
  messageId: string,
  input: ThreadMessage['input'],
  value: string,
  alwaysAllow?: { rule: string; scope: 'task' | 'project' | 'global' },
) {
  if (!input) return;
  // Only the answer: the request itself stays as the control plane wrote it.
  await updateDoc(doc(db, paths.messages(taskId), messageId), {
    'input.answer': clean({ value, alwaysAllow, answeredAt: Date.now() }),
  });
}

/** Takes back an "Always allow" answer: the rule leaves the task, project or global settings. */
export async function removeAllowRule(
  where: { scope: 'global' } | { scope: 'project' | 'task'; id: string },
  rule: string,
) {
  const path =
    where.scope === 'global'
      ? paths.settings()
      : where.scope === 'project'
        ? paths.project(where.id)
        : paths.task(where.id);
  await updateDoc(doc(db, path), { allowRules: arrayRemove(rule), updatedAt: Date.now() });
}

export async function addLinkArtifact(taskId: string, name: string, url: string) {
  await addDoc(collection(db, paths.artifacts(taskId)), {
    kind: 'link',
    role: 'reference',
    name: name || url,
    url,
    createdBy: 'user',
    createdAt: Date.now(),
  });
}

/** A download URL for a file the control plane stored, e.g. a question's screenshot. */
export function storedFileUrl(storagePath: string): Promise<string> {
  return getDownloadURL(ref(storage, storagePath));
}

async function uploadTaskFile(taskId: string, file: File) {
  const storagePath = `tasks/${taskId}/${Date.now()}-${file.name}`;
  await uploadBytes(ref(storage, storagePath), file, { contentType: file.type || undefined });
  const url = await getDownloadURL(ref(storage, storagePath));
  return { storagePath, url };
}

/** Best effort: a stored file left behind costs a little space, never correctness. */
async function removeStoredFile(storagePath?: string) {
  if (!storagePath) return;
  await deleteObject(ref(storage, storagePath)).catch(() => {});
}

export async function addFileArtifact(taskId: string, file: File) {
  const { storagePath, url } = await uploadTaskFile(taskId, file);
  await addDoc(collection(db, paths.artifacts(taskId)), {
    kind: 'file',
    role: 'reference',
    name: file.name,
    storagePath,
    url,
    createdBy: 'user',
    createdAt: Date.now(),
  });
}

/**
 * Replaces an artifact's content with an uploaded file, keeping its place and role. A note the
 * agent wrote stays a note when the new file is text, so the agent keeps reading it directly.
 */
export async function replaceArtifact(taskId: string, artifact: Artifact, file: File) {
  const target = doc(db, paths.artifacts(taskId), artifact.id);
  if (artifact.kind === 'text' && isTextual(file.name, file.type)) {
    await updateDoc(target, { name: file.name, text: await file.text() });
    return;
  }
  const { storagePath, url } = await uploadTaskFile(taskId, file);
  await updateDoc(target, {
    kind: 'file',
    name: file.name,
    storagePath,
    url,
    text: deleteField(),
  });
  if (artifact.storagePath !== storagePath) await removeStoredFile(artifact.storagePath);
}

export async function deleteArtifact(taskId: string, artifact: Artifact) {
  await deleteDoc(doc(db, paths.artifacts(taskId), artifact.id));
  await removeStoredFile(artifact.storagePath);
}

export async function saveProject(project: Partial<Project> & { name: string }) {
  const now = Date.now();
  const { id, ...rest } = project;
  if (id) {
    await updateDoc(doc(db, paths.project(id)), clean({ ...rest, updatedAt: now }));
    return id;
  }
  const created = await addDoc(
    collection(db, paths.projects()),
    clean({ description: '', defaults: {}, instructions: '', ...rest, createdAt: now, updatedAt: now }),
  );
  return created.id;
}

export async function deleteProject(id: string) {
  await deleteDoc(doc(db, paths.project(id)));
}

export async function saveSettings(changes: Partial<GlobalSettings>) {
  await setDoc(doc(db, paths.settings()), clean(changes), { merge: true });
}

export const usePersonalInfo = () => useLiveDoc(paths.profile(), PersonalInfo);

/** Replaces the whole profile: what the form shows is what the agent gets. */
export async function savePersonalInfo(info: Omit<PersonalInfo, 'updatedAt'>) {
  await setDoc(doc(db, paths.profile()), clean({ ...info, updatedAt: Date.now() }));
}

export const useVault = () =>
  useLiveQuery(query(collection(db, paths.vault()), orderBy('name')), VaultEntry, []);

/** Values go to the server only; a field left empty keeps its stored value. */
export async function saveVaultEntry(entry: VaultSaveRequest) {
  await httpsCallable(functions, 'vaultSave')(clean(entry));
}

export async function deleteVaultEntry(id: string) {
  await httpsCallable(functions, 'vaultDelete')({ id });
}

/* ------------------------------ GitHub ------------------------------ */

export const useGitHub = () => useLiveDoc(paths.github(), GitHubConnection);

/**
 * Settings › GitHub: before the app exists, posts the manifest to GitHub (which creates the app
 * and comes back); afterwards, opens the page to install it on your repos.
 */
export async function connectGitHub(org?: string) {
  const res = await httpsCallable<
    { org?: string },
    { kind: 'manifest'; postUrl: string; manifest: string } | { kind: 'install'; url: string }
  >(functions, 'githubConnect')(org ? { org } : {});
  if (res.data.kind === 'install') {
    window.location.assign(res.data.url);
    return;
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = res.data.postUrl;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = res.data.manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export async function syncGitHub() {
  await httpsCallable(functions, 'githubSync')({});
}

export async function disconnectGitHub() {
  await httpsCallable(functions, 'githubDisconnect')({});
}

export const EUR = eur;
