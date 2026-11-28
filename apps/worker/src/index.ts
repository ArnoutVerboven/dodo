/**
 * Cloud Run Job entrypoint: one execution per run. The dispatcher passes the run id and a
 * short-lived custom token for the run's own Firebase identity; the container's service
 * account has no roles. Exit code 0 whatever the run's outcome, so Cloud Run never retries.
 * A standby execution gets its run later, through its standby document (standby.ts).
 */
import { StartupClock } from '@dodo/agent';
import { envFromProcess, executeRun } from './run.js';
import { standbyFromProcess, waitForRun } from './standby.js';

// Static imports are evaluated by now: the bundle's load time is the gap from process start.
let clock = new StartupClock();
clock.add({ process_start: performance.timeOrigin });
clock.mark('worker_loaded');

let guard: NodeJS.Timeout | undefined;
const armGuard = (ms: number) => {
  clearTimeout(guard);
  guard = setTimeout(() => {
    console.error('worker: hard timeout reached, exiting');
    process.exit(0);
  }, ms);
};
const timeoutS = Number(process.env.DODO_TIMEOUT_S ?? 3600);
// A standby (started before its run, see standby.ts) waits until its `until` at most; the
// run it takes gets its own timeout once it is handed over.
const standby = standbyFromProcess();
armGuard(
  standby
    ? Math.max(30_000, standby.until - Date.now() + 30_000)
    : Math.max(30, timeoutS - 20) * 1000,
);

// The Mac daemon writes `release` on stdin when other work is queued: a hold for an answer
// ends and the run parks. Cloud Run gives no stdin; then this never fires.
const holdRelease = new AbortController();
if (process.env.DODO_HOLD_RELEASE === 'stdin') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (/\brelease\b/.test(chunk)) holdRelease.abort();
  });
  process.stdin.on('error', () => {});
  process.stdin.unref?.();
}

try {
  if (standby) {
    const base = envFromProcess({ runId: '', runToken: '' });
    console.log(`standby ${standby.id}: waiting for a run`);
    const assigned = await waitForRun(standby, base);
    if (!assigned) {
      console.log(`standby ${standby.id}: no run came; exiting`);
    } else {
      console.log(`standby ${standby.id}: took run ${assigned.runId}`);
      const runS = assigned.timeoutSeconds ?? 3600;
      armGuard(Math.max(30, runS - 20) * 1000);
      // The run's start is timed from now: the container was up long before it was queued.
      clock = new StartupClock();
      clock.mark('standby_taken');
      await executeRun(
        {
          ...base,
          runId: assigned.runId,
          runToken: assigned.runToken,
          deadline: Date.now() + (runS - 20) * 1000,
        },
        clock,
        { holdRelease: holdRelease.signal },
      );
    }
  } else {
    await executeRun(envFromProcess(), clock, { holdRelease: holdRelease.signal });
  }
} catch (err) {
  console.error('worker failed', err);
} finally {
  clearTimeout(guard);
  process.exit(0);
}
