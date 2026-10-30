import { contextWindow } from '@dodo/budget';
import {
  COMPACT_SYSTEM,
  compactedSession,
  compactionRequest,
  formatTokens,
  isLocalModel,
  paths,
  type Run,
  summaryText,
  type Task,
} from '@dodo/core';
import type { Storage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { type GatewayDeps, generateWithBudget } from './gateway.js';
import { loadSession } from './run-control.js';
import { scopesForRun, stripUndefined } from './runtime.js';

export interface CompactDeps {
  gateway: GatewayDeps;
  storage: Storage;
  now?: () => number;
}

export type CompactResult =
  | { state: 'requested' }
  | { state: 'nothing' }
  | { state: 'compacted'; before?: number; after: number };

const LIVE: Run['state'][] = ['queued', 'dispatching', 'claimed', 'running'];

/**
 * The local model is not reachable from here: a conversation it had is summarised by the
 * cheapest Gemini model instead (cents), and the next run on the Mac continues from that.
 */
const LOCAL_COMPACTION_MODEL = 'gemini-3.1-flash-lite';

/**
 * "Compact" in the task view. A run working on the task compacts at its next step (the
 * heartbeat hands it the request). Otherwise the latest conversation is summarised here and
 * stored as the session the next run continues from, under a run of its own with
 * trigger `compact`, so the summary call is metered and charged to the task like any step.
 */
export async function compactTask(deps: CompactDeps, taskId: string): Promise<CompactResult> {
  const db = deps.gateway.db;
  const now = deps.now ?? Date.now;
  const taskRef = db.doc(paths.task(taskId));
  const task = (await taskRef.get()).data() as Task | undefined;
  if (!task) throw new HttpsError('not-found', 'Unknown task');

  if (task.activeRunId) {
    const runRef = db.doc(paths.run(task.activeRunId));
    const active = (await runRef.get()).data() as Run | undefined;
    if (active && LIVE.includes(active.state)) {
      await runRef.update({ compact: true });
      return { state: 'requested' };
    }
  }

  const latest = await db
    .collection(paths.runs())
    .where('taskId', '==', taskId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const last = latest.docs[0]?.data() as Run | undefined;
  const sessionPath = last?.sessionPath;
  if (!last || !sessionPath) return { state: 'nothing' };
  const session = await loadSession(deps, sessionPath).catch(() => []);
  if (session.length < 2) return { state: 'nothing' };
  const model = isLocalModel(last.model) ? LOCAL_COMPACTION_MODEL : last.model;

  // The run starts out with the old session: if the summary fails, or a comment starts a run
  // meanwhile, the conversation simply continues from where it was.
  const runRef = db.collection(paths.runs()).doc();
  const started = now();
  const run: Omit<Run, 'id'> = {
    taskId,
    projectId: task.projectId,
    device: 'gcp',
    model,
    state: 'running',
    trigger: 'compact',
    generation: 0,
    interrupt: false,
    compact: false,
    attempts: 0,
    sessionPath,
    spent: 0,
    steps: 0,
    startedAt: started,
    createdAt: started,
    updatedAt: started,
  };
  await runRef.create(stripUndefined(run));

  try {
    const reply = await generateWithBudget(
      deps.gateway,
      {
        scopes: scopesForRun({ taskId, projectId: task.projectId }),
        taskId,
        projectId: task.projectId,
        runId: runRef.id,
        description: `compaction (${model})`,
      },
      {
        model,
        systemInstruction: COMPACT_SYSTEM,
        contents: compactionRequest(session),
        purpose: 'compact',
      },
    );
    const summary = summaryText(reply.content);
    if (!summary) throw new Error('The model returned an empty summary');
    const compacted = compactedSession(summary);
    const path = paths.sessionBlob(runRef.id);
    await deps.storage
      .bucket()
      .file(path)
      .save(JSON.stringify(compacted), { contentType: 'application/json' });
    const after = await deps.gateway.provider.countTokens({
      model,
      contents: compacted,
    });
    const before = task.context?.tokens;
    const end = now();
    const batch = db.batch();
    batch.update(runRef, {
      state: 'succeeded',
      endReason: 'compacted',
      sessionPath: path,
      endedAt: end,
      updatedAt: end,
    });
    batch.update(taskRef, {
      'context.tokens': after,
      'context.max': contextWindow(last.model),
      'context.model': last.model,
      'context.updatedAt': end,
      'context.compactedAt': end,
    });
    batch.create(db.collection(paths.messages(taskId)).doc(), {
      author: 'system',
      body: `Conversation compacted to save context${
        before ? `: ${formatTokens(before)} → ${formatTokens(after)} tokens` : ''
      }. The agent continues from a summary of it.`,
      runId: runRef.id,
      createdAt: end,
    });
    await batch.commit();
    return { state: 'compacted', before, after };
  } catch (err) {
    const message = (err as Error).message;
    await runRef.update({
      state:
        err instanceof HttpsError && err.code === 'resource-exhausted'
          ? 'budget_exhausted'
          : 'failed',
      endReason: 'error',
      error: `Compaction failed: ${message}`,
      // Keep pointing at the full conversation.
      sessionPath,
      endedAt: now(),
      updatedAt: now(),
    });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', `Compaction failed: ${message}`);
  }
}
