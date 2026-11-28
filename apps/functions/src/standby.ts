import { computeCost, monthKey } from '@dodo/budget';
import {
  type Device,
  eur,
  type GlobalSettings,
  isLocalModel,
  localModelOnRemote,
  type Project,
  paths,
  type Run,
  resolveAiConfig,
  type Standby,
  type Task,
} from '@dodo/core';
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { routeDevice, routeLocalModel } from './routing.js';
import { WORKER_BROWSER_GIB, WORKER_VCPU } from './runtime.js';

/**
 * Standby workers. A remote run used to start its Cloud Run container only once it was queued,
 * and that container start (10–45 s in production) was most of the wait. Now the web app says
 * when a run is likely to follow (the new-task form opened, or the answer box of a task whose
 * run has parked) and the control plane starts one container ahead of it. The container signs
 * in as a standby identity, listens to its own `standbys/{id}` document and, when the dispatcher
 * assigns it the next remote run, runs it as if it had been started for it.
 *
 * Hard limits, so a standby can never cost more than its cap:
 *  - one at a time: a second request while one waits reuses it;
 *  - a monthly cap in euro (`STANDBY_MONTHLY_CAP`, 1 €): each standby reserves its whole wait
 *    up front and gets back the part it did not wait when a run takes it; over the cap, no
 *    standby starts and runs start the old way;
 *  - the worker exits by itself at `expiresAt`, and when its document says cancelled/expired;
 *  - the lease sweep (every 5 minutes) marks an expired standby as such and cancels its
 *    Cloud Run execution, in case the worker hung.
 *
 * Always the browser job: it can run any remote run (the browser starts only for runs that
 * want one), and which one a task wants is decided only once it is written.
 */

/** How long a standby waits for a run (what the owner asked for: time to write a task). */
export const STANDBY_WAIT_MS = 600_000;
/** At most this much a month on standby waiting (micro-euro). */
export const STANDBY_MONTHLY_CAP = eur(1);
/** A standby must have this long left to take a run (the run starts on it before it exits). */
const MIN_LEFT_MS = 30_000;
/** A second request reuses a standby with at least this long left; else a new one starts. */
const REUSE_LEFT_MS = 120_000;
/** A standby not ready yet is still taken if it was started this recently (it is booting). */
const BOOT_GRACE_MS = 120_000;
/** A run handed to a standby that does not start it within this long gets a fresh container. */
export const TAKEOVER_GRACE_MS = 90_000;
/** Cloud Run's own limit on top of the wait: the longest run a standby may take (MAX_TIMEOUT_S). */
const RUN_MAX_S = 3600;

export const STANDBY_SHAPE = { vcpu: WORKER_VCPU, gib: WORKER_BROWSER_GIB };
export const standbyUid = (id: string) => `standby:${id}`;

/** What one standby reserves: the whole wait plus a little for the container's own exit. */
export function standbyReserve(waitMs = STANDBY_WAIT_MS): number {
  return computeCost(waitMs / 1000 + 10, STANDBY_SHAPE.vcpu, STANDBY_SHAPE.gib);
}

export interface StandbyExecutor {
  startStandby(env: Record<string, string>, timeoutSeconds: number): Promise<string>;
  cancel?(execution: string): Promise<void>;
}

export interface StandbyDeps {
  db: Firestore;
  auth: Auth;
  executor: StandbyExecutor;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Overrides for tests. */
  waitMs?: number;
  capMicro?: number;
}

export type EnsureResult =
  | { state: 'started' | 'reused'; id: string }
  | { state: 'over_budget' | 'halted' | 'failed' };

/** Starts a standby unless one is already waiting with enough time left, or the cap is reached. */
export async function ensureStandby(deps: StandbyDeps): Promise<EnsureResult> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const waitMs = deps.waitMs ?? STANDBY_WAIT_MS;
  const cap = deps.capMicro ?? STANDBY_MONTHLY_CAP;
  const reserve = standbyReserve(waitMs);
  const usageRef = db.doc(paths.standbyUsage(monthKey(now)));
  const ref = db.collection(paths.standbys()).doc();

  const decided = await db.runTransaction(async (t): Promise<EnsureResult> => {
    const halted = (await t.get(db.doc(paths.settings()))).get('halted') === true;
    if (halted) return { state: 'halted' };
    const open = await t.get(
      db.collection(paths.standbys()).where('state', 'in', ['starting', 'waiting']),
    );
    const live = open.docs.find((d) => (d.get('expiresAt') as number) - now >= REUSE_LEFT_MS);
    if (live) return { state: 'reused', id: live.id };
    const spent = ((await t.get(usageRef)).get('spent') as number | undefined) ?? 0;
    if (spent + reserve > cap) return { state: 'over_budget' };
    const doc: Omit<Standby, 'id'> = {
      state: 'starting',
      expiresAt: now + waitMs,
      reserved: reserve,
      createdAt: now,
      updatedAt: now,
    };
    t.create(ref, doc);
    t.set(
      usageRef,
      { spent: FieldValue.increment(reserve), count: FieldValue.increment(1), updatedAt: now },
      { merge: true },
    );
    return { state: 'started', id: ref.id };
  });
  if (decided.state !== 'started') return decided;

  try {
    const token = await deps.auth.createCustomToken(standbyUid(ref.id), { standby: ref.id });
    const execution = await deps.executor.startStandby(
      {
        DODO_STANDBY_ID: ref.id,
        DODO_STANDBY_TOKEN: token,
        DODO_STANDBY_UNTIL: String(now + waitMs),
        // The entrypoint's hard stop: the wait, then the longest run it may take.
        DODO_TIMEOUT_S: String(Math.ceil(waitMs / 1000) + RUN_MAX_S),
      },
      Math.ceil(waitMs / 1000) + RUN_MAX_S + 60,
    );
    await ref.update({ execution, updatedAt: (deps.now ?? Date.now)() });
    deps.log?.('standby started', { standbyId: ref.id, execution });
    return decided;
  } catch (err) {
    deps.log?.('standby start failed', { standbyId: ref.id, err: String(err) });
    // Nothing runs: give the reservation back and make sure no run is handed to it.
    await ref.update({ state: 'expired', updatedAt: now });
    await usageRef.set({ spent: FieldValue.increment(-reserve), updatedAt: now }, { merge: true });
    return { state: 'failed' };
  }
}

/**
 * Inside the dispatcher's transaction (after its reads of the run): the standby that takes this
 * run, if one can. Reads only; `assignStandby` does the writes once the transaction has done
 * all its reads.
 */
export async function findStandby(
  db: Firestore,
  t: Transaction,
  now: number,
): Promise<Standby | undefined> {
  const open = await t.get(
    db.collection(paths.standbys()).where('state', 'in', ['starting', 'waiting']),
  );
  const usable = open.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Standby)
    .filter(
      (s) =>
        s.expiresAt - now >= MIN_LEFT_MS &&
        (s.readyAt !== undefined || now - s.createdAt <= BOOT_GRACE_MS),
    )
    // Ready ones first, then the one with the most time left.
    .sort((a, b) => Number(!!b.readyAt) - Number(!!a.readyAt) || b.expiresAt - a.expiresAt);
  return usable[0];
}

/** Hands the run to the standby, and gives back the reservation for the part it did not wait. */
export function assignStandby(
  db: Firestore,
  t: Transaction,
  standby: Standby,
  runId: string,
  now: number,
  waitMs = STANDBY_WAIT_MS,
) {
  const unused = Math.max(0, Math.min(1, (standby.expiresAt - now) / waitMs));
  const refund = Math.floor(standby.reserved * unused);
  t.update(db.doc(paths.standby(standby.id)), {
    state: 'assigned',
    runId,
    assignedAt: now,
    updatedAt: now,
  });
  if (refund > 0) {
    t.set(
      db.doc(paths.standbyUsage(monthKey(standby.createdAt))),
      { spent: FieldValue.increment(-refund), updatedAt: now },
      { merge: true },
    );
  }
}

/**
 * The form closed without a task: the standby stops now instead of waiting out its 10 minutes,
 * and the time it did not wait goes back to the month.
 */
export async function cancelStandbys(deps: StandbyDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const waitMs = deps.waitMs ?? STANDBY_WAIT_MS;
  const db = deps.db;
  const cancelled = await db.runTransaction(async (t) => {
    const open = await t.get(
      db.collection(paths.standbys()).where('state', 'in', ['starting', 'waiting']),
    );
    const out: Standby[] = [];
    for (const d of open.docs) {
      const s = { id: d.id, ...d.data() } as Standby;
      const unused = Math.max(0, Math.min(1, (s.expiresAt - now) / waitMs));
      const refund = Math.floor(s.reserved * unused);
      t.update(d.ref, { state: 'cancelled', updatedAt: now });
      if (refund > 0)
        t.set(
          db.doc(paths.standbyUsage(monthKey(s.createdAt))),
          { spent: FieldValue.increment(-refund), updatedAt: now },
          { merge: true },
        );
      out.push(s);
    }
    return out;
  });
  // The worker stops on its document; cancelling the execution too is belt and braces.
  for (const s of cancelled) {
    if (s.execution && deps.executor.cancel)
      await deps.executor
        .cancel(s.execution)
        .catch((err) => deps.log?.('standby cancel failed', { standbyId: s.id, err: String(err) }));
  }
  return cancelled.length;
}

/**
 * Lease sweep, before the stale-run reaper: standbys past their time are marked expired and
 * their execution cancelled (a worker that hung would otherwise run to Cloud Run's timeout),
 * and a run handed to a standby that never started it is queued again for a fresh container.
 */
export async function sweepStandbys(
  deps: StandbyDeps & { redispatch: (runId: string) => Promise<unknown> },
): Promise<{ expired: string[]; requeued: string[] }> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const expired: string[] = [];
  const requeued: string[] = [];
  const open = await db
    .collection(paths.standbys())
    .where('state', 'in', ['starting', 'waiting', 'assigned'])
    .get();
  for (const d of open.docs) {
    const s = { id: d.id, ...d.data() } as Standby;
    if (s.state === 'assigned') {
      if (!s.runId || (s.assignedAt ?? 0) + TAKEOVER_GRACE_MS > now) continue;
      const runRef = db.doc(paths.run(s.runId));
      const back = await db.runTransaction(async (t) => {
        const run = (await t.get(runRef)).data() as Run | undefined;
        // Started (running) or ended: the standby did its job; nothing to sweep any more.
        if (run?.state !== 'claimed' || run.standbyId !== s.id || run.lease) {
          t.update(d.ref, { state: 'expired', runToken: FieldValue.delete(), updatedAt: now });
          return false;
        }
        t.update(runRef, {
          state: 'queued',
          standbyId: FieldValue.delete(),
          execution: FieldValue.delete(),
          updatedAt: now,
        });
        t.update(d.ref, { state: 'expired', runToken: FieldValue.delete(), updatedAt: now });
        return true;
      });
      if (back) {
        requeued.push(s.runId);
        deps.log?.('standby never took its run; starting a fresh worker', {
          standbyId: s.id,
          runId: s.runId,
        });
        await deps.redispatch(s.runId);
      }
    } else if (s.expiresAt + 60_000 <= now) {
      await d.ref.update({ state: 'expired', updatedAt: now });
      expired.push(s.id);
    } else continue;
    if (s.execution && deps.executor.cancel)
      await deps.executor.cancel(s.execution).catch(() => undefined);
  }
  return { expired, requeued };
}

export interface PrepareRequest {
  /** The answer box of this task (a question or approval whose run has parked). */
  taskId?: string;
  /** The new-task form: its AI settings and project so far. */
  draft?: { ai?: Partial<Task['ai']>; projectId?: string };
  /** The form closed without a task: stop the standby. */
  cancel?: boolean;
}

export type PrepareResult =
  | EnsureResult
  | { state: 'cancelled'; count: number }
  | { state: 'warming'; deviceId: string }
  | { state: 'live' | 'mac' | 'nothing' };

/**
 * `runPrepare`: the web app's hint that a run is about to start. Routes it the way `enqueueRun`
 * would and gets that place ready: a standby for a remote run, the local model for a Mac run on
 * it. A task whose run is still live (holding for the answer) needs nothing: the answer reaches
 * that run directly.
 */
export async function prepareRun(deps: StandbyDeps, req: PrepareRequest): Promise<PrepareResult> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  if (req.cancel) return { state: 'cancelled', count: await cancelStandbys(deps) };

  let task: Partial<Task> = { ai: { enabled: true, ...(req.draft?.ai ?? {}) } as Task['ai'] };
  let projectId = req.draft?.projectId;
  if (req.taskId) {
    const t = (await db.doc(paths.task(req.taskId)).get()).data() as Task | undefined;
    if (!t?.ai?.enabled || t.status === 'done' || t.status === 'cancelled')
      return { state: 'nothing' };
    if (t.activeRunId) {
      const run = (await db.doc(paths.run(t.activeRunId)).get()).data() as Run | undefined;
      if (run && ['queued', 'dispatching', 'claimed', 'running'].includes(run.state))
        return { state: 'live' };
    }
    task = t;
    projectId = t.projectId;
  }
  const [settingsSnap, projectSnap, devicesSnap] = await Promise.all([
    db.doc(paths.settings()).get(),
    projectId ? db.doc(paths.project(projectId)).get() : Promise.resolve(undefined),
    db.collection(paths.devices()).get(),
  ]);
  const settings = (settingsSnap.data() ?? {}) as Partial<GlobalSettings>;
  const project = projectSnap?.data() as Project | undefined;
  const devices = devicesSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Device);
  const ai = resolveAiConfig({ ai: task.ai as Task['ai'] }, project, {
    defaults: settings.defaults ?? {},
    defaultTaskBudget: settings.defaultTaskBudget ?? 500_000,
  });
  // The same choice as enqueueRun: an inherited local model on a Remote task runs on the cloud.
  const onRemote = localModelOnRemote(ai, task.ai as Task['ai']);
  if (onRemote === 'conflict') return { state: 'nothing' };
  const local = onRemote === 'ok' && isLocalModel(ai.model);
  const route =
    (local ? routeLocalModel(ai.device, devices) : undefined) ??
    routeDevice(ai.device, ai.folder, devices, now);
  if (route.device === 'gcp') return ensureStandby(deps);
  const deviceId = route.device.startsWith('mac:') ? route.device.slice(4) : undefined;
  if (local && deviceId) {
    await db.doc(paths.device(deviceId)).update({ warmUpAt: now });
    return { state: 'warming', deviceId };
  }
  return { state: 'mac' };
}
