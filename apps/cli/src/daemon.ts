import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_HEARTBEAT_MS,
  DEVICE_PROTOCOL,
  type DeviceClaimRequest,
  type DeviceClaimResponse,
  type DeviceEgressRequest,
  type DeviceEgressResponse,
  type DeviceReleaseRequest,
  deviceChoice,
  paths,
} from '@dodo/core';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { type Clients, connect, currentUser, SIGNED_OUT } from './auth.js';
import { type BrowserServer, browserReport, startBrowserServer } from './browser.js';
import { type CliConfig, expandFolder, VERSION, workRoot } from './config.js';
import { credentialStore } from './credentials.js';
import {
  finishSandboxed,
  sandboxConfig,
  sandboxedArgv,
  sandboxInputsFor,
  sandboxReport,
  startSandbox,
  stopSandbox,
} from './sandbox.js';

export interface DaemonOptions {
  /** Exit after the first run finishes (tests). */
  once?: boolean;
  log?: (message: string) => void;
}

/** Why the daemon stopped on its own; each one is something you fix, not a crash. */
export type StopReason = 'revoked' | 'update_needed' | 'signed_out' | 'sandbox_missing' | 'once';

/**
 * The daemon: sign in as the device, say hello every 30 s, and when a queued run addressed to
 * this Mac appears, claim it and hand it to a worker process with the run's own identity. One
 * run at a time; a Mac is one pair of hands.
 */
export async function runDaemon(config: CliConfig, opts: DaemonOptions = {}): Promise<StopReason> {
  const log = opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
  const store = credentialStore();
  const clients = connect(config, store);
  await currentUser(clients).catch((err) => {
    throw new Error(`${(err as Error).message} (${config.name})`);
  });
  const me = deviceChoice(config.deviceId);

  // The sandbox first: without it the daemon does not take work.
  const report = sandboxReport();
  for (const w of report.warnings) log(`sandbox: ${w}`);
  if (report.state === 'unavailable') {
    log(`Cannot sandbox the worker on this machine: ${report.problems.join('; ')}`);
    return 'sandbox_missing';
  }
  const entry = workerEntry();
  if (!existsSync(entry)) throw new Error(`worker not built at ${entry}; run \`pnpm build\``);
  // Your Chrome, when the extension and its token are there; otherwise runs that ask for it
  // get the message from `dodo doctor` instead.
  const browser = browserReport(config);
  for (const p of browser.problems) log(`browser: ${p}`);
  let browserServer: BrowserServer | undefined;
  let current: string | undefined;
  const decided = new Map<string, DeviceEgressResponse>();
  if (report.state === 'on') {
    const folders = config.folders.map(expandFolder);
    await startSandbox(
      sandboxConfig(sandboxInputsFor(config, folders, entry)),
      async (host, port) => {
        const runId = current;
        if (!runId) return 'no run is active on this Mac';
        const key = `${runId} ${host}`;
        let verdict = decided.get(key);
        if (!verdict) {
          try {
            const r = await httpsCallable<DeviceEgressRequest, DeviceEgressResponse>(
              clients.functions,
              'deviceEgress',
            )({ deviceId: config.deviceId, runId, host, port });
            verdict = r.data;
            decided.set(key, verdict);
          } catch (err) {
            log(`run ${runId}: could not ask about ${host}: ${(err as Error).message}`);
            verdict = { allow: false, by: 'policy check failed' };
          }
          log(
            `run ${runId}: ${verdict.allow ? 'allowed' : 'refused'} ${host} (${verdict.by ?? 'not on the allowlist'})`,
          );
        }
        return verdict.allow
          ? true
          : `${host} is not on this task's allowlist: add it in Settings, or approve the command in the task`;
      },
    );
  }
  log(
    `${config.name} (${me}) online, protocol ${DEVICE_PROTOCOL}, sandbox ${report.state}, browser ${browser.state}, waiting for runs`,
  );

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
      void Promise.all([stopSandbox(), browserServer?.stop()]).then(() => resolve(reason));
    };

    // Presence. Firestore rules let the device write only these fields on its own document.
    const deviceRef = doc(clients.db, paths.device(config.deviceId));
    const hello = () =>
      updateDoc(deviceRef, {
        lastSeen: Date.now(),
        version: VERSION,
        protocol: DEVICE_PROTOCOL,
        folders: config.folders,
        browser: browser.state === 'ready',
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
        if (!user) stop('signed_out', SIGNED_OUT);
      }),
    );

    // Work: every queued run addressed to this Mac, oldest first.
    const next = async () => {
      if (stopped || busy) return;
      const runId = pending.shift();
      if (!runId) return;
      busy = runId;
      try {
        const claimed = await claim(clients, config, runId, browser.state === 'ready');
        if (claimed) {
          log(`run ${runId}: claimed for task ${claimed.taskId}`);
          current = runId;
          let browserUrl: string | undefined;
          if (claimed.browser && config.browser?.token) {
            // Started once, kept across runs: the connection to Chrome, and with it the login
            // you did in a tab for one run, outlives the run.
            if (browserServer && !browserServer.running()) {
              log('browser: the server is gone; starting it again');
              browserServer = undefined;
            }
            if (!browserServer) {
              try {
                browserServer = await startBrowserServer(
                  config.browser.token,
                  path.join(workRoot(), 'browser'),
                  log,
                );
                log(`browser: Playwright MCP at ${browserServer.url}`);
              } catch (err) {
                log(`run ${runId}: ${(err as Error).message}; running without the browser`);
              }
            }
            browserUrl = browserServer?.url;
          }
          const code = await execute(
            config,
            runId,
            claimed,
            log,
            report.state === 'on',
            browserUrl,
          );
          current = undefined;
          for (const k of [...decided.keys()]) if (k.startsWith(`${runId} `)) decided.delete(k);
          log(`run ${runId}: worker exited with ${code}`);
          // A worker that did not report its end leaves the run claimed: end it as failed now.
          const released = await httpsCallable<DeviceReleaseRequest, { released: boolean }>(
            clients.functions,
            'deviceRelease',
          )({ deviceId: config.deviceId, runId, exitCode: code }).catch((err: Error) => {
            log(`run ${runId}: could not release: ${err.message}`);
            return undefined;
          });
          if (released?.data.released) log(`run ${runId}: marked failed (worker did not finish)`);
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
async function claim(clients: Clients, config: CliConfig, runId: string, browser: boolean) {
  try {
    const r = await httpsCallable<DeviceClaimRequest, DeviceClaimResponse>(
      clients.functions,
      'deviceClaim',
    )({
      deviceId: config.deviceId,
      runId,
      protocol: DEVICE_PROTOCOL,
      version: VERSION,
      browser,
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

async function execute(
  config: CliConfig,
  runId: string,
  claimed: DeviceClaimResponse,
  log: (m: string) => void,
  sandboxed: boolean,
  browserUrl?: string,
): Promise<number | null> {
  const entry = workerEntry();
  mkdirSync(workRoot(), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    // Inside the sandbox every connection goes through its proxy; node's fetch only follows the
    // proxy variables when told to (the experimental-agent warning is noise).
    NODE_USE_ENV_PROXY: '1',
    NODE_OPTIONS: '--disable-warning=UNDICI-EHPA',
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
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (browserUrl) env.DODO_BROWSER_URL = browserUrl;
  const argv = sandboxed
    ? await sandboxedArgv([process.execPath, entry], workRoot(), runId, {
        proxyLoopback: !!config.emulatorHost,
        localBinding: !!browserUrl,
      })
    : [process.execPath, entry];
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      env,
      cwd: workRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n'))
        if (line.trim()) log(`  [${runId.slice(0, 6)}] ${line}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    // The worker guards its own timeout; this is the backstop if it hangs on exit.
    const killer = setTimeout(() => child.kill('SIGKILL'), (claimed.timeoutSeconds + 60) * 1000);
    const done = (code: number | null) => {
      clearTimeout(killer);
      if (sandboxed) {
        const refused = finishSandboxed(runId);
        for (const line of refused.slice(0, 20)) log(`run ${runId}: sandbox refused ${line}`);
        if (refused.length > 20) log(`run ${runId}: …and ${refused.length - 20} more`);
      }
      resolve(code);
    };
    child.on('close', done);
    child.on('error', (err) => {
      log(`worker failed to start: ${err.message}`);
      done(null);
    });
  });
}
