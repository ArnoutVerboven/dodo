import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase/app';
import { signInWithCustomToken } from 'firebase/auth';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { connect, type WorkerEnv } from './adapters.js';

/**
 * A standby worker (apps/functions/src/standby.ts): started before its run exists, it signs in
 * as its standby identity, says it listens, and waits on its own document until the control
 * plane hands it a run (run id and token) or calls it off. It also exits by itself at `until`.
 * Signing in here also opens the connections to Firebase that the run's own sign-in reuses.
 */
export interface StandbyEnv {
  id: string;
  token: string;
  /** Epoch ms: no run by then, exit. */
  until: number;
}

export interface Assignment {
  runId: string;
  runToken: string;
  timeoutSeconds?: number;
}

export function standbyFromProcess(): StandbyEnv | undefined {
  const id = process.env.DODO_STANDBY_ID;
  const token = process.env.DODO_STANDBY_TOKEN;
  const until = Number(process.env.DODO_STANDBY_UNTIL);
  if (!id || !token || !Number.isFinite(until)) return undefined;
  return { id, token, until };
}

export async function waitForRun(
  standby: StandbyEnv,
  base: Pick<WorkerEnv, 'firebase' | 'region' | 'emulatorHost'>,
  now: () => number = Date.now,
): Promise<Assignment | undefined> {
  const app = initializeApp(
    {
      apiKey: base.firebase.apiKey,
      projectId: base.firebase.projectId,
      appId: base.firebase.appId,
    },
    `standby-${standby.id}`,
  );
  try {
    const clients = connect(app, { ...base, runId: '', runToken: '' });
    await signInWithCustomToken(clients.auth, standby.token);
    const ref = doc(clients.db, paths.standby(standby.id));
    return await new Promise<Assignment | undefined>((resolve) => {
      let done = false;
      const finish = (a: Assignment | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(a);
      };
      const timer = setTimeout(() => finish(undefined), Math.max(0, standby.until - now()));
      let announced = false;
      const unsubscribe = onSnapshot(
        ref,
        (snap) => {
          const d = snap.data();
          if (!d) return finish(undefined);
          if (d.state === 'cancelled' || d.state === 'expired') return finish(undefined);
          if (typeof d.runId === 'string' && typeof d.runToken === 'string')
            return finish({
              runId: d.runId,
              runToken: d.runToken,
              timeoutSeconds: typeof d.timeoutSeconds === 'number' ? d.timeoutSeconds : undefined,
            });
          if (d.state === 'starting' && !announced) {
            announced = true;
            // Taken already (assigned) makes this fail; the snapshot with the token follows.
            void updateDoc(ref, { state: 'waiting', readyAt: now() }).catch(() => undefined);
          }
        },
        (err) => {
          console.error(`standby ${standby.id}: listener failed`, err);
          finish(undefined);
        },
      );
    });
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
}
