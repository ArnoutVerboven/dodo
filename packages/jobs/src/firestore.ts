import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  ConnectorStatus,
  Job,
  JobItem,
  type JobRun,
  JobThread,
  jobPaths,
  LIMITS,
} from './model.js';
import type { ClaimResult, JobStore } from './ports.js';

/** A processing claim older than this belongs to a run that died; it may be taken again. */
const STALE_CLAIM_MS = 15 * 60_000;

const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class FirestoreJobStore implements JobStore {
  constructor(private readonly db: Firestore) {}

  async getJob(jobId: string) {
    const snap = await this.db.doc(jobPaths.job(jobId)).get();
    if (!snap.exists) return undefined;
    const parsed = Job.safeParse({ id: snap.id, ...snap.data() });
    return parsed.success ? parsed.data : undefined;
  }

  lock(jobId: string, runId: string, now: number, ttlMs: number) {
    const ref = this.db.doc(jobPaths.job(jobId));
    return this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return false;
      const lock = snap.get('state.lock') as { until?: number } | undefined;
      if (lock?.until && lock.until > now) return false;
      t.update(ref, { 'state.lock': { runId, until: now + ttlMs } });
      return true;
    });
  }

  async unlock(
    jobId: string,
    runId: string,
    state: Partial<Job['state']>,
    extra: { enabled?: boolean } = {},
  ) {
    const ref = this.db.doc(jobPaths.job(jobId));
    await this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(clean(state))) patch[`state.${k}`] = v;
      if (snap.get('state.lock.runId') === runId) patch['state.lock'] = FieldValue.delete();
      if (extra.enabled !== undefined) patch.enabled = extra.enabled;
      if (Object.keys(patch).length) t.update(ref, patch);
    });
  }

  async saveRun(run: JobRun) {
    const { id, ...rest } = run;
    await this.db.doc(jobPaths.run(id)).set(clean(rest));
  }

  claimItem(
    jobId: string,
    item: Pick<JobItem, 'id' | 'threadId'>,
    now: number,
  ): Promise<ClaimResult> {
    const ref = this.db.doc(jobPaths.item(jobId, item.id));
    return this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) {
        const cur = snap.data() as Partial<JobItem>;
        const attempts = cur.attempts ?? 1;
        const retry =
          (cur.state === 'failed' && attempts < LIMITS.maxAttempts) ||
          (cur.state === 'processing' &&
            now - (cur.claimedAt ?? 0) > STALE_CLAIM_MS &&
            attempts < LIMITS.maxAttempts);
        if (!retry) return 'exists';
        t.update(ref, { state: 'processing', attempts: attempts + 1, claimedAt: now });
        return 'claimed';
      }
      t.create(ref, {
        threadId: item.threadId,
        state: 'processing',
        attempts: 1,
        claimedAt: now,
        updatedAt: now,
      });
      return 'claimed';
    });
  }

  async peekItem(jobId: string, itemId: string) {
    const snap = await this.db.doc(jobPaths.item(jobId, itemId)).get();
    if (!snap.exists) return undefined;
    const parsed = JobItem.safeParse({ id: snap.id, ...snap.data() });
    return parsed.success ? parsed.data : undefined;
  }

  async updateItem(jobId: string, itemId: string, patch: Partial<JobItem>) {
    const { id: _id, ...rest } = patch;
    await this.db.doc(jobPaths.item(jobId, itemId)).set(clean(rest), { merge: true });
  }

  async releaseItem(jobId: string, itemId: string) {
    await this.db.doc(jobPaths.item(jobId, itemId)).delete();
  }

  async getThread(jobId: string, threadId: string) {
    const snap = await this.db.doc(jobPaths.thread(jobId, threadId)).get();
    if (!snap.exists) return undefined;
    const parsed = JobThread.safeParse({ id: snap.id, ...snap.data() });
    return parsed.success ? parsed.data : undefined;
  }

  async setThread(
    jobId: string,
    thread: Omit<JobThread, 'approval' | 'event'> & {
      approval?: JobThread['approval'] | null;
      event?: JobThread['event'] | null;
    },
  ) {
    const { id, approval, event, ...rest } = thread;
    const data: Record<string, unknown> = clean(rest);
    if (approval === null) data.approval = FieldValue.delete();
    else if (approval) data.approval = approval;
    if (event === null) data.event = FieldValue.delete();
    else if (event) data.event = event;
    await this.db.doc(jobPaths.thread(jobId, id)).set(data, { merge: true });
  }

  async openThreads(jobId: string, limit: number) {
    const snap = await this.db
      .collection(jobPaths.threads(jobId))
      .where('open', '==', true)
      // Least recently checked first: every check touches updatedAt, so all links get a turn.
      .orderBy('updatedAt', 'asc')
      .limit(limit)
      .get();
    return snap.docs.flatMap((d) => {
      const parsed = JobThread.safeParse({ id: d.id, ...d.data() });
      return parsed.success ? [parsed.data] : [];
    });
  }

  countTask(jobId: string, date: string, max: number) {
    const ref = this.db.doc(jobPaths.job(jobId));
    return this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const day = snap.get('state.day') as { date?: string; tasksCreated?: number } | undefined;
      const used = day?.date === date ? (day.tasksCreated ?? 0) : 0;
      if (used >= max) return false;
      t.update(ref, { 'state.day': { date, tasksCreated: used + 1 } });
      return true;
    });
  }

  async connector(id: string) {
    const snap = await this.db.doc(jobPaths.connector(id)).get();
    if (!snap.exists) return undefined;
    const parsed = ConnectorStatus.safeParse({ id: snap.id, ...snap.data() });
    return parsed.success ? parsed.data : undefined;
  }

  async setConnector(id: string, status: Omit<ConnectorStatus, 'id'>) {
    await this.db.doc(jobPaths.connector(id)).set(clean(status));
  }
}
