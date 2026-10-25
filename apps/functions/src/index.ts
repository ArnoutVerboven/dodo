import { CloudBillingClient } from '@google-cloud/billing';
import { paths } from '@dodo/core';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineInt, defineString } from 'firebase-functions/params';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { handleBudgetNotification, parseNotification } from './kill-switch.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2 });

const HALT_AT = defineInt('BUDGET_HALT_AT', { default: 40 });
const DETACH_AT = defineInt('BUDGET_DETACH_AT', { default: 45 });
const CURRENCY = defineString('BUDGET_CURRENCY', { default: 'EUR' });

/** Receives Cloud Billing budget notifications for the project. See infra/bootstrap.sh. */
export const killSwitch = onMessagePublished(
  { topic: 'billing-alerts', retry: true, maxInstances: 1, serviceAccount: 'dodo-killswitch@' },
  async (event) => {
    let notification: ReturnType<typeof parseNotification>;
    try {
      notification = parseNotification(event.data.message.json);
    } catch (err) {
      // Retrying a malformed message would never succeed; log it and stop.
      logger.error('Ignoring malformed budget notification', { err: String(err) });
      return;
    }
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
    if (!projectId) throw new Error('Project id not available');
    const db = getFirestore();
    const billing = new CloudBillingClient();
    const projectName = `projects/${projectId}`;
    const settingsRef = db.doc(paths.settings());

    await handleBudgetNotification(
      notification,
      { haltAt: HALT_AT.value(), detachAt: DETACH_AT.value(), currency: CURRENCY.value() },
      {
        isHalted: async () => (await settingsRef.get()).get('halted') === true,
        halt: async (reason) => {
          await settingsRef.set({ halted: true, haltReason: reason, haltedAt: Date.now() }, { merge: true });
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
