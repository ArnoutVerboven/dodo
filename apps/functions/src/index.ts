import { paths } from '@dodo/core';
import { CloudBillingClient } from '@google-cloud/billing';
import { ExecutionsClient } from '@google-cloud/run';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineInt, defineString } from 'firebase-functions/params';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { claimOwnership as claim } from './claim-ownership.js';
import { handleMessage, parseMessage } from './kill-switch.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2 });

const HALT_AT = defineInt('BUDGET_HALT_AT', { default: 40 });
const DETACH_AT = defineInt('BUDGET_DETACH_AT', { default: 45 });
const CURRENCY = defineString('BUDGET_CURRENCY', { default: 'EUR' });
const OWNER_EMAIL = defineString('OWNER_EMAIL', { default: '' });
const REGION = 'europe-west1';
const WORKER_JOB = 'dodo-worker';

/** Receives Cloud Billing budget notifications for the project. See infra/bootstrap.sh. */
export const killSwitch = onMessagePublished(
  { topic: 'billing-alerts', retry: true, maxInstances: 1, serviceAccount: 'dodo-killswitch@' },
  async (event) => {
    let message: ReturnType<typeof parseMessage>;
    try {
      message = parseMessage(event.data.message.json);
    } catch (err) {
      // Retrying a malformed message would never succeed; log it and stop.
      logger.error('Ignoring malformed kill switch message', { err: String(err) });
      return;
    }
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
    if (!projectId) throw new Error('Project id not available');
    const db = getFirestore();
    const billing = new CloudBillingClient();
    const projectName = `projects/${projectId}`;
    const settingsRef = db.doc(paths.settings());

    await handleMessage(
      message,
      { haltAt: HALT_AT.value(), detachAt: DETACH_AT.value(), currency: CURRENCY.value() },
      {
        isHalted: async () => (await settingsRef.get()).get('halted') === true,
        halt: async (reason) => {
          await settingsRef.set(
            { halted: true, haltReason: reason, haltedAt: Date.now() },
            { merge: true },
          );
        },
        cancelRunningExecutions: async () => {
          const runs = new ExecutionsClient();
          const parent = `projects/${projectId}/locations/${REGION}/jobs/${WORKER_JOB}`;
          let cancelled = 0;
          try {
            for await (const execution of runs.listExecutionsAsync({ parent })) {
              const running = !execution.completionTime;
              if (running && execution.name) {
                await runs.cancelExecution({ name: execution.name });
                cancelled++;
              }
            }
          } catch (err) {
            // NOT_FOUND: the worker job does not exist yet (before phase 2). Nothing to cancel.
            if ((err as { code?: number }).code !== 5) throw err;
          }
          return cancelled;
        },
        isBillingEnabled: async () => {
          const [info] = await billing.getProjectBillingInfo({ name: projectName });
          return info.billingEnabled === true;
        },
        detachBilling: async () => {
          await billing.updateProjectBillingInfo({
            name: projectName,
            projectBillingInfo: { billingAccountName: '' },
          });
        },
        log: (message, data) => logger.warn(message, data),
      },
    );
  },
);

/**
 * Grants the `dodo_owner` claim to the configured OWNER_EMAIL on first sign-in. Idempotent,
 * refuses every other account. The web app calls it after sign-in and refreshes its token.
 */
export const claimOwnership = onCall({ maxInstances: 1 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const auth = getAuth();
  const result = await claim(uid, {
    ownerEmail: OWNER_EMAIL.value(),
    getUser: async (id) => {
      const u = await auth.getUser(id);
      return { email: u.email, emailVerified: u.emailVerified, claims: u.customClaims ?? {} };
    },
    setClaims: (id, claims) => auth.setCustomUserClaims(id, claims),
  });
  if (!result.ok) {
    logger.warn('Ownership claim refused', { uid, reason: result.reason });
    throw new HttpsError('permission-denied', result.reason);
  }
  if (!result.alreadyOwner) logger.info('Ownership granted', { uid });
  return result;
});
