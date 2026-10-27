import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_HEARTBEAT_MS,
  DEVICE_PROTOCOL,
  type DeviceClaimResponse,
  deviceChoice,
  paths,
} from '@dodo/core';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { type Clients, connect, currentUser } from './auth.js';
import { type CliConfig, expandFolder, VERSION, workRoot } from './config.js';
import { credentialStore } from './credentials.js';

export interface DaemonOptions {
  /** Exit after the first run finishes (tests). */
  once?: boolean;
  log?: (message: string) => void;
}

/** Why the daemon stopped on its own; each one is something you fix, not a crash. */
export type StopReason = 'revoked' | 'update_needed' | 'signed_out' | 'once';

/**
 * The daemon: sign in as the device, say hello every 30 s, and when a queued run addressed to
 * this Mac appears, claim it and hand it to a worker process with the run's own identity. One
 * run at a time; a Mac is one pair of hands.
 */
export async function runDaemon(config: CliConfig, opts: DaemonOptions = {}): Promise<StopReason> {
  const log = opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
  const clients = connect(config, credentialStore());
  await currentUser(clients.auth).catch((err) => {
    throw new Error(`${(err as Error).message} (${config.name})`);
  });
  const me = deviceChoice(config.deviceId);
  log(`${config.name} (${me}) online, protocol ${DEVICE_PROTOCOL}, waiting for runs`);

  return new Promise<StopReason>((resolve) => {
    const subs: Array<() => void> = [];
    let stopped = false;
    let busy: string | undefined;
    const pending: string[] = [];
    const stop = (reason: StopReason, why: string) => {
      if (stopped) return;
      stopped = true;
      log(why);
      for (const s of subs) s();
      clearInterval(beat);
      resolve(reason);
    };

    // Presence. Firestore rules let the device write only these fields on its own document.
    const deviceRef = doc(clients.db, paths.device(config.deviceId));
    const hello = () =>
      updateDoc(deviceRef, {
        lastSeen: Date.now(),
        version: VERSION,
        protocol: DEVICE_PROTOCOL,
        folders: config.folders,
        updatedAt: Date.now(),
      }).catch((err: { code?: string }) => {
        if (String(err.code).endsWith('permission-denied'))
          stop('revoked', 'This Mac was revoked in Settings.');
        else log(`heartbeat failed: ${String((err as Error).message ?? err)}`);
      });
    const beat = setInterval(hello, DEVICE_HEARTBEAT_MS);
    void hello();
    subs.push(
      onSnapshot(
        deviceRef,
        (snap) => {
          if (!snap.exists() || snap.get('state') !== 'approved')
            stop('revoked', 'This Mac was revoked in Settings.');
        },
        () => stop('revoked', 'This Mac was revoked in Settings.'),
      ),
    );
    subs.push(
      clients.auth.onAuthStateChanged((user) => {
        if (!user) stop('signed_out', 'Signed out. Run `pnpm dodo login <code>` again.');
      }),
    );

    // Work: every queued run addressed to this Mac, oldest first.
    const next = async () => {
      if (stopped || busy) return;
      const runId = pending.shift();
      if (!runId) return;
      busy = runId;
      try {
        const claimed = await claim(clients, config, runId);
        if (claimed) {
          log(`run ${runId}: claimed for task ${claimed.taskId}`);
          const code = await execute(config, runId, claimed, log);
          log(`run ${runId}: worker exited with ${code}`);
          if (opts.once) return stop('once', 'Done (--once).');
        }
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (/update_needed/.test(e.message ?? '')) {
          return stop(
            'update_needed',
            `The server needs a newer daemon: ${e.message}. Pull the repo and run \`pnpm build\`.`,
          );
        }
        if (String(e.code).endsWith('permission-denied'))
          return stop('revoked', `Refused: ${e.message}`);
        log(`run ${runId}: ${e.message ?? String(err)}`);
      } finally {
        busy = undefined;
      }
      void next();
    };
    const queued = query(
      collection(clients.db, paths.runs()),
      where('device', '==', me),
      where('state', '==', 'queued'),
    );
    subs.push(
      onSnapshot(
        queued,
        (snap) => {
          const ids = snap.docs
            .sort((a, b) => Number(a.get('createdAt')) - Number(b.get('createdAt')))
            .map((d) => d.id)
            .filter((id) => id !== busy && !pending.includes(id));
          pending.push(...ids);
          void next();
        },
        (err) => stop('revoked', `Cannot watch runs: ${err.message}`),
      ),
    );
  });
}

/** Take the lease. `undefined` when somebody else (or an earlier instance) got there first. */
async function claim(clients: Clients, config: CliConfig, runId: string) {
  try {
    const r = await httpsCallable<unknown, DeviceClaimResponse>(
      clients.functions,
      'deviceClaim',
    )({
      deviceId: config.deviceId,
      runId,
      protocol: DEVICE_PROTOCOL,
      version: VERSION,
    });
    return r.data;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (String(e.code).endsWith('failed-precondition') && /Run is/.test(e.message ?? ''))
      return undefined;
    throw err;
  }
}

/** The worker is the same bundle Cloud Run uses; it only ever sees the run token. */
export function workerEntry(): string {
  return (
    process.env.DODO_WORKER_ENTRY ??
    fileURLToPath(new URL('../../worker/dist/index.js', import.meta.url))
  );
}

function execute(
  config: CliConfig,
  runId: string,
  claimed: DeviceClaimResponse,
  log: (m: string) => void,
): Promise<number | null> {
  const entry = workerEntry();
  if (!existsSync(entry)) throw new Error(`worker not built at ${entry}; run \`pnpm build\``);
  mkdirSync(workRoot(), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    DODO_RUN_ID: runId,
    DODO_RUN_TOKEN: claimed.token,
    DODO_TIMEOUT_S: String(claimed.timeoutSeconds),
    DODO_WORK_ROOT: workRoot(),
    DODO_FOLDERS: config.folders.map(expandFolder).join(':'),
    FIREBASE_API_KEY: config.firebase.apiKey,
    FIREBASE_PROJECT_ID: config.firebase.projectId,
    FUNCTIONS_REGION: config.region,
  };
  if (config.firebase.appId) env.FIREBASE_APP_ID = config.firebase.appId;
  if (config.emulatorHost) env.FIREBASE_EMULATOR_HOST = config.emulatorHost;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n'))
        if (line.trim()) log(`  [${runId.slice(0, 6)}] ${line}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    // The worker guards its own timeout; this is the backstop if it hangs on exit.
    const killer = setTimeout(() => child.kill('SIGKILL'), (claimed.timeoutSeconds + 60) * 1000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve(code);
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      log(`worker failed to start: ${err.message}`);
      resolve(null);
    });
  });
}
