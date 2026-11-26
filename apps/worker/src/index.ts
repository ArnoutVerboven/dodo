/**
 * Cloud Run Job entrypoint: one execution per run. The dispatcher passes the run id and a
 * short-lived custom token for the run's own Firebase identity; the container's service
 * account has no roles. Exit code 0 whatever the run's outcome, so Cloud Run never retries.
 */
import { StartupClock } from '@dodo/agent';
import { envFromProcess, executeRun } from './run.js';

// Static imports are evaluated by now: the bundle's load time is the gap from process start.
const clock = new StartupClock();
clock.add({ process_start: performance.timeOrigin });
clock.mark('worker_loaded');

const timeoutS = Number(process.env.DODO_TIMEOUT_S ?? 3600);
const guard = setTimeout(
  () => {
    console.error('worker: hard timeout reached, exiting');
    process.exit(0);
  },
  Math.max(30, timeoutS - 20) * 1000,
);

try {
  await executeRun(envFromProcess(), clock);
} catch (err) {
  console.error('worker failed', err);
} finally {
  clearTimeout(guard);
  process.exit(0);
}
