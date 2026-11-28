/**
 * Emulator stand-in for Cloud Run Jobs: watches for runs the dispatcher marked `claimed`
 * with a local token and executes them in this process, one at a time.
 *
 *   pnpm emulators            (auth, firestore, storage, functions)
 *   pnpm --filter @dodo/worker dev:emulators
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { envFromProcess, executeRun } from './run.js';
import { waitForRun } from './standby.js';

const host = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
process.env.FIRESTORE_EMULATOR_HOST ??= `${host}:8080`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `${host}:9099`;
const projectId = process.env.FIREBASE_PROJECT_ID ?? 'demo-dodo';
initializeApp({ projectId });
const db = getFirestore();

const busy = new Set<string>();
console.log('dev worker: watching for claimed runs on the emulator');
db.collection('runs')
  .where('state', '==', 'claimed')
  .onSnapshot(async (snap) => {
    for (const d of snap.docs) {
      const token = d.get('localToken') as string | undefined;
      if (!token || busy.has(d.id)) continue;
      busy.add(d.id);
      console.log(`dev worker: executing run ${d.id}`);
      try {
        await executeRun(envFromProcess({ runId: d.id, runToken: token, emulatorHost: host }));
      } catch (err) {
        console.error(`dev worker: run ${d.id} crashed`, err);
      } finally {
        busy.delete(d.id);
      }
    }
  });

// Standbys (standby.ts): the same wait as in a Cloud Run container, then the run it gets.
db.collection('standbys')
  .where('state', '==', 'starting')
  .onSnapshot(async (snap) => {
    for (const d of snap.docs) {
      const token = d.get('localToken') as string | undefined;
      const key = `standby:${d.id}`;
      if (!token || busy.has(key)) continue;
      busy.add(key);
      console.log(`dev worker: standby ${d.id} waiting`);
      try {
        const base = envFromProcess({ runId: '', runToken: '', emulatorHost: host });
        const until = d.get('expiresAt') as number;
        const assigned = await waitForRun({ id: d.id, token, until }, base);
        if (!assigned) {
          console.log(`dev worker: standby ${d.id} got no run`);
          continue;
        }
        console.log(`dev worker: standby ${d.id} executing run ${assigned.runId}`);
        await executeRun({ ...base, runId: assigned.runId, runToken: assigned.runToken });
      } catch (err) {
        console.error(`dev worker: standby ${d.id} crashed`, err);
      } finally {
        busy.delete(key);
      }
    }
  });
