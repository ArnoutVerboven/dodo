import {
  DEVICE_PROTOCOL,
  DEVICE_RUN_TIMEOUT_S,
  type Device,
  type DeviceClaimRequest,
  type DeviceClaimResponse,
  type DeviceEgressRequest,
  type DeviceEgressResponse,
  type DeviceRegisterRequest,
  type DeviceRegisterResponse,
  type DeviceReleaseRequest,
  deviceChoice,
  deviceUid,
  paths,
  type Run,
} from '@dodo/core';
import { hostAllowedBy } from '@dodo/policy';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { policyForRun } from './run-control.js';
import { type Caller, LEASE_MS, runUid, stripUndefined } from './runtime.js';

/**
 * The Mac daemon's side of the control plane. A device identity (`device:{id}`) can do two
 * things: claim a run that is addressed to it, and report presence on its own document (that
 * one goes through Firestore rules, not through here). Everything a run does afterwards uses
 * the per-run identity, exactly like a Cloud Run worker, so revoking a device cannot leave a
 * live run with more rights than it had.
 */
export interface DeviceDeps {
  db: Firestore;
  /** What the daemon needs to use the Firebase client SDKs (the API-restricted worker key). */
  clientConfig?: { apiKey: string; projectId: string };
  auth: {
    createCustomToken(uid: string, claims?: object): Promise<string>;
    revokeRefreshTokens(uid: string): Promise<void>;
    deleteUser(uid: string): Promise<void>;
  };
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** A pairing code older than this is refused even if nobody used it. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

/** `dodo login <code>`: the code from Settings becomes an approved device with its own sign-in. */
export async function registerDevice(
  deps: DeviceDeps,
  req: DeviceRegisterRequest,
): Promise<DeviceRegisterResponse> {
  const now = (deps.now ?? Date.now)();
  const settingsRef = deps.db.doc(paths.settings());
  const ref = deps.db.collection(paths.devices()).doc();
  await deps.db.runTransaction(async (t) => {
    const settings = (await t.get(settingsRef)).data() ?? {};
    const pairing = settings.devicePairing as { code: string; createdAt: number } | undefined;
    if (!pairing || pairing.code !== req.code) {
      throw new HttpsError('permission-denied', 'Wrong or already used pairing code');
    }
    if (now - pairing.createdAt > PAIRING_CODE_TTL_MS) {
      throw new HttpsError('permission-denied', 'Pairing code expired; generate a new one');
    }
    const device: Omit<Device, 'id'> = {
      name: req.name,
      platform: req.platform,
      state: 'approved',
      protocol: req.protocol,
      version: req.version,
      folders: [],
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
    };
    t.create(ref, stripUndefined(device));
    // The code is single-use, whatever happens to the device later.
    t.update(settingsRef, { devicePairing: FieldValue.delete() });
  });
  const token = await deps.auth.createCustomToken(deviceUid(ref.id), { device: ref.id });
  deps.log?.('device paired', { deviceId: ref.id, name: req.name });
  return { deviceId: ref.id, token, firebase: deps.clientConfig };
}

/**
 * The daemon saw a queued run addressed to it: take the lease and hand back a run token.
 * Mirrors the dispatcher's `queued → claimed` step for Cloud Run, with the device as owner.
 */
export async function claimRun(
  deps: DeviceDeps,
  caller: Caller | undefined,
  req: DeviceClaimRequest,
): Promise<DeviceClaimResponse> {
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in first');
  if (caller.uid !== deviceUid(req.deviceId) || caller.claims.device !== req.deviceId) {
    throw new HttpsError('permission-denied', 'Not this device');
  }
  if (req.protocol < DEVICE_PROTOCOL) {
    throw new HttpsError(
      'failed-precondition',
      `update_needed: this daemon speaks protocol ${req.protocol}, the server needs ${DEVICE_PROTOCOL}`,
    );
  }
  const now = (deps.now ?? Date.now)();
  const deviceRef = deps.db.doc(paths.device(req.deviceId));
  const runRef = deps.db.doc(paths.run(req.runId));
  const claimed = await deps.db.runTransaction(async (t) => {
    const device = (await t.get(deviceRef)).data() as Device | undefined;
    if (device?.state !== 'approved') {
      throw new HttpsError('permission-denied', 'This Mac is revoked or unknown');
    }
    const run = (await t.get(runRef)).data() as Run | undefined;
    if (!run) throw new HttpsError('not-found', 'Unknown run');
    if (run.device !== deviceChoice(req.deviceId)) {
      throw new HttpsError('permission-denied', 'This run belongs to another device');
    }
    if (run.state !== 'queued') {
      throw new HttpsError('failed-precondition', `Run is ${run.state}`);
    }
    const generation = (run.generation ?? 0) + 1;
    t.update(runRef, {
      state: 'claimed',
      generation,
      attempts: FieldValue.increment(1),
      execution: `mac:${req.deviceId}`,
      lease: { owner: deviceUid(req.deviceId), expiresAt: now + LEASE_MS },
      updatedAt: now,
    });
    t.update(
      deviceRef,
      stripUndefined({
        currentRunId: req.runId,
        lastSeen: now,
        protocol: req.protocol,
        version: req.version,
        updatedAt: now,
      }),
    );
    return { taskId: run.taskId, generation, browser: run.browser === true };
  });
  const token = await deps.auth.createCustomToken(runUid(req.runId), {
    run: req.runId,
    taskId: claimed.taskId,
    generation: claimed.generation,
  });
  return {
    token,
    taskId: claimed.taskId,
    generation: claimed.generation,
    timeoutSeconds: DEVICE_RUN_TIMEOUT_S,
    // The run says whether it wants a browser (the setting, the router or a step-up decided).
    browser: req.browser === true && claimed.browser,
  };
}

/** The run, when the caller is the approved device it is addressed to; an error otherwise. */
async function runOfDevice(
  deps: Pick<DeviceDeps, 'db'>,
  caller: Caller | undefined,
  req: { deviceId: string; runId: string },
): Promise<Run> {
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in first');
  if (caller.uid !== deviceUid(req.deviceId) || caller.claims.device !== req.deviceId) {
    throw new HttpsError('permission-denied', 'Not this device');
  }
  const device = (await deps.db.doc(paths.device(req.deviceId)).get()).data() as Device | undefined;
  if (device?.state !== 'approved') {
    throw new HttpsError('permission-denied', 'This Mac is revoked or unknown');
  }
  const snap = await deps.db.doc(paths.run(req.runId)).get();
  const run = snap.data() as Run | undefined;
  if (!run || run.device !== deviceChoice(req.deviceId)) {
    throw new HttpsError('permission-denied', 'This run belongs to another device');
  }
  return { ...run, id: req.runId };
}

/**
 * The worker exited without finishing its run (a crash, a kill, a sandbox it could not start
 * in). Instead of waiting for the lease to lapse, the run ends as failed now, through the same
 * path a worker's own error report takes, so the task shows what happened.
 */
export async function releaseRun(
  deps: Pick<DeviceDeps, 'db' | 'log'>,
  caller: Caller | undefined,
  req: DeviceReleaseRequest,
  finishRun: (run: Run, error: string) => Promise<void>,
): Promise<{ released: boolean }> {
  const run = await runOfDevice(deps, caller, req);
  if (run.state !== 'claimed' && run.state !== 'running') return { released: false };
  const error =
    req.exitCode === null
      ? 'the worker on this Mac was killed'
      : `the worker on this Mac exited with code ${req.exitCode}`;
  deps.log?.('device release', { deviceId: req.deviceId, runId: req.runId, error });
  await finishRun(run, error);
  return { released: true };
}

/**
 * The sandbox around a Mac run saw a connection to a host its base allowlist does not cover.
 * Allowed when the task's policy allows it: an allowed host, an allow rule that names it, or the
 * approval the user just gave for the command that reaches it. Judged here, by trusted code,
 * from the current rules, so an approval card answered "always allow" counts at once.
 */
export async function egressCheck(
  deps: Pick<DeviceDeps, 'db' | 'log'>,
  caller: Caller | undefined,
  req: DeviceEgressRequest,
): Promise<DeviceEgressResponse> {
  const run = await runOfDevice(deps, caller, req);
  if (run.state !== 'claimed' && run.state !== 'running') {
    return { allow: false, by: `run is ${run.state}` };
  }
  const policy = await policyForRun(deps.db, run);
  const answer = (run as Run & { answer?: { value?: string; suggestedRule?: string } }).answer;
  const approved =
    answer?.suggestedRule && /^(y|yes|ok|approve|allow)/i.test(String(answer.value ?? '').trim())
      ? [answer.suggestedRule]
      : [];
  const by = hostAllowedBy({ ...policy, allow: [...policy.allow, ...approved] }, req.host);
  deps.log?.('device egress', { deviceId: req.deviceId, runId: req.runId, host: req.host, by });
  return by ? { allow: true, by } : { allow: false };
}

/**
 * Revoking or removing a device in Settings must also kill its sign-in: Firestore rules already
 * stop a revoked device, this stops it from refreshing its token at all.
 */
export async function onDeviceChanged(
  deps: DeviceDeps,
  deviceId: string,
  before: Pick<Device, 'state'> | undefined,
  after: Pick<Device, 'state'> | undefined,
): Promise<void> {
  const wasLive = before?.state === 'approved';
  const revoked = !!after && after.state === 'revoked' && before?.state !== 'revoked';
  const removed = !after && !!before;
  if (!revoked && !removed) return;
  const uid = deviceUid(deviceId);
  const ignoreMissing = (err: unknown) => {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  };
  try {
    await deps.auth.revokeRefreshTokens(uid).catch(ignoreMissing);
    if (removed) await deps.auth.deleteUser(uid).catch(ignoreMissing);
    deps.log?.(removed ? 'device removed' : 'device revoked', { deviceId, wasLive });
  } catch (err) {
    deps.log?.('device revoke failed', { deviceId, err: String(err) });
  }
}
