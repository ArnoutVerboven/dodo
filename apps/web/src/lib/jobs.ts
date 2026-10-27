import {
  ConnectorStatus,
  type GmailFollowupConfig,
  Job,
  type JobKind,
  JobRun,
  jobPaths,
} from '@dodo/jobs/model';
import {
  collection,
  doc,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useLiveDoc, useLiveQuery } from './data';
import { db, functions } from './firebase';

/** Data for the Jobs tab. Jobs live in their own collections; see docs/JOBS.md. */

export const useJob = (id: string) => useLiveDoc(jobPaths.job(id), Job);

export const useJobRuns = (jobId: string, max = 20) =>
  useLiveQuery(
    query(
      collection(db, jobPaths.runs()),
      where('jobId', '==', jobId),
      orderBy('startedAt', 'desc'),
      limit(max),
    ),
    JobRun,
    [jobId, max],
  );

export const useConnector = (id: string) => useLiveDoc(jobPaths.connector(id), ConnectorStatus);

/** Creates the job document the first time it is switched on or configured. */
export async function saveJob(
  id: string,
  kind: JobKind,
  exists: boolean,
  changes: { enabled?: boolean; config?: Partial<GmailFollowupConfig> },
) {
  const ref = doc(db, jobPaths.job(id));
  const clean = JSON.parse(JSON.stringify(changes));
  if (!exists) {
    await setDoc(ref, {
      kind,
      enabled: false,
      config: {},
      ...clean,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else {
    await updateDoc(ref, { ...clean, updatedAt: Date.now() });
  }
}

export async function connectGoogle(): Promise<void> {
  const res = await httpsCallable<unknown, { url: string }>(functions, 'jobsGoogleConnect')({});
  window.location.assign(res.data.url);
}

export async function disconnectGoogle(): Promise<void> {
  await httpsCallable(functions, 'jobsGoogleDisconnect')({});
}

export async function runJobNow(
  jobId: string,
  dryRun: boolean,
): Promise<{ runId: string; state: string; error?: string }> {
  const res = await httpsCallable<unknown, { runId: string; state: string; error?: string }>(
    functions,
    'jobsRunNow',
    { timeout: 540_000 },
  )({ jobId, dryRun });
  return res.data;
}
