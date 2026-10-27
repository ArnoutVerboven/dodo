import { type FirebaseApp, initializeApp } from 'firebase/app';
import {
  type Auth,
  connectAuthEmulator,
  initializeAuth,
  onAuthStateChanged,
  type Persistence,
  type User,
} from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, type Functions, getFunctions } from 'firebase/functions';
import type { CliConfig } from './config.js';
import type { CredentialStore } from './credentials.js';

/**
 * The Firebase Auth SDK persists the signed-in user (with its refresh token) through a
 * persistence class it instantiates itself. This one keeps it in the credential store, so the
 * daemon comes back signed in after a restart and the SDK refreshes the ID token on its own.
 */
let activeStore: CredentialStore | undefined;

class StorePersistence {
  static type = 'LOCAL';
  readonly type = 'LOCAL';
  private read(): Record<string, unknown> {
    try {
      return JSON.parse(activeStore?.load() ?? '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  async _isAvailable() {
    return !!activeStore;
  }
  async _set(key: string, value: unknown) {
    activeStore?.save(JSON.stringify({ ...this.read(), [key]: value }));
  }
  async _get(key: string) {
    return this.read()[key] ?? null;
  }
  async _remove(key: string) {
    const all = this.read();
    delete all[key];
    if (Object.keys(all).length) activeStore?.save(JSON.stringify(all));
    else activeStore?.clear();
  }
  _addListener() {}
  _removeListener() {}
}

export function storePersistence(store: CredentialStore): Persistence {
  activeStore = store;
  return StorePersistence as unknown as Persistence;
}

export interface Clients {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
}

/**
 * The SDK keys the persisted user by API key and app name, so every command uses this one name:
 * a sign-in made under another name is invisible to the next process.
 */
const APP_NAME = 'dodo-device';

export function connect(
  config: Pick<CliConfig, 'firebase' | 'region' | 'emulatorHost'>,
  store: CredentialStore,
): Clients {
  const app = initializeApp(config.firebase, APP_NAME);
  const auth = initializeAuth(app, { persistence: storePersistence(store) });
  const db = getFirestore(app);
  const functions = getFunctions(app, config.region);
  if (config.emulatorHost) {
    connectAuthEmulator(auth, `http://${config.emulatorHost}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, config.emulatorHost, 8080);
    connectFunctionsEmulator(functions, config.emulatorHost, 5001);
  }
  return { app, auth, db, functions };
}

/** What to do when the sign-in is gone: revoking a Mac in Settings invalidates its tokens. */
export const SIGNED_OUT =
  'The sign-in of this Mac is no longer valid: it was revoked or removed in Settings. Run `pnpm dodo logout`, then pair again with a new code.';
const NEVER_SIGNED_IN = 'Not signed in. Run `pnpm dodo login <code>` with a code from Settings.';

/**
 * Resolves with the restored user. Throws when there is no sign-in, with a message that says
 * whether there never was one or it stopped working (the store still holds the old one).
 */
export function currentUser(
  auth: Auth,
  store?: CredentialStore,
  timeoutMs = 15_000,
): Promise<User> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('Sign-in did not restore in time'));
    }, timeoutMs);
    const stop = onAuthStateChanged(auth, (user) => {
      clearTimeout(timer);
      stop();
      if (user) resolve(user);
      else reject(new Error(store?.load() ? SIGNED_OUT : NEVER_SIGNED_IN));
    });
  });
}
