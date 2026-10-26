import { paths } from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';
import type { Notification } from './telegram.js';

/**
 * Web push through Firebase Cloud Messaging to the owner's installed app (desktop or iPhone home
 * screen). Each browser that turned push on in Settings has a document in `pushTokens`.
 * Data-only messages: the web app's service worker builds the notification itself, so every push
 * shows one (iOS revokes the subscription of a worker that stays silent).
 */
export interface PushMessage {
  token: string;
  data: Record<string, string>;
  webpush: { headers: Record<string, string> };
}

export interface PushResult {
  success: boolean;
  error?: { code: string };
}

export interface PushDeps {
  db: Firestore;
  send: (messages: PushMessage[]) => Promise<PushResult[]>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Errors that mean the browser unsubscribed or the token is gone for good. */
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export async function notifyPush(deps: PushDeps, n: Notification): Promise<number> {
  const snap = await deps.db.collection(paths.pushTokens()).get();
  const tokens = snap.docs.map((d) => d.id);
  if (!tokens.length) return 0;

  const data: Record<string, string> = {
    title: n.title.slice(0, 120),
    body: n.body.slice(0, 400),
    url: `${n.appUrl}/tasks/${n.taskId}`,
    // Same tag per task: a newer notification replaces the older one instead of stacking.
    tag: `task-${n.taskId}`,
  };
  if (n.input) data.kind = n.input.kind;

  const messages = tokens.map((token) => ({
    token,
    data,
    webpush: { headers: { Urgency: n.input ? 'high' : 'normal', TTL: String(24 * 3600) } },
  }));

  let results: PushResult[];
  try {
    results = await deps.send(messages);
  } catch (err) {
    deps.log?.('push send failed', { err: String(err) });
    return 0;
  }

  let delivered = 0;
  await Promise.all(
    results.map(async (r, i) => {
      if (r.success) {
        delivered++;
        return;
      }
      const code = r.error?.code ?? 'unknown';
      if (DEAD_TOKEN.has(code)) {
        await deps.db
          .doc(paths.pushToken(tokens[i] as string))
          .delete()
          .catch(() => {});
      } else {
        deps.log?.('push failed', { code });
      }
    }),
  );
  return delivered;
}
