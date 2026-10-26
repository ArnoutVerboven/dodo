import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { deleteToken, getMessaging, getToken, isSupported } from 'firebase/messaging';
import { paths } from '@dodo/core';
import { app, db, usingEmulators } from './firebase';

/** Optional: the public key from Firebase console › Cloud Messaging › Web Push certificates.
 * Without it the Firebase SDK uses its default key, which FCM also accepts. */
const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY || undefined;

export type PushState =
  | 'unsupported' // browser has no web push (on iPhone: open dodo from the home screen)
  | 'blocked' // notifications denied in browser settings
  | 'off'
  | 'on';

export async function pushSupported(): Promise<boolean> {
  if (usingEmulators) return false;
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return false;
  return isSupported().catch(() => false);
}

const registration = () => navigator.serviceWorker.register('/sw.js', { scope: '/' });

async function currentToken(): Promise<string | undefined> {
  const reg = await registration();
  await navigator.serviceWorker.ready;
  return getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
}

/** Whether this browser is registered, without prompting. */
export async function pushState(): Promise<PushState> {
  if (!(await pushSupported())) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  try {
    const token = await currentToken();
    if (!token) return 'off';
    return (await getDoc(doc(db, paths.pushToken(token)))).exists() ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Asks for permission (must run from a tap) and registers this browser. */
export async function enablePush(): Promise<PushState> {
  if (!(await pushSupported())) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  const token = await currentToken();
  if (!token) return 'off';
  await setDoc(doc(db, paths.pushToken(token)), {
    createdAt: Date.now(),
    userAgent: navigator.userAgent.slice(0, 200),
  });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const token = await currentToken().catch(() => undefined);
  if (token) {
    await deleteDoc(doc(db, paths.pushToken(token)));
    await deleteToken(getMessaging(app)).catch(() => {});
  }
  return 'off';
}
