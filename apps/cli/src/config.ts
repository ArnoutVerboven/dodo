import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Everything the daemon needs besides its sign-in, in ~/.dodo/config.json. */
export interface CliConfig {
  deviceId: string;
  name: string;
  firebase: { apiKey: string; projectId: string; appId?: string };
  region: string;
  /** Set when paired against the local emulators (development only). */
  emulatorHost?: string;
  /** Folders the agent may work in on this Mac. Nothing until you add one. */
  folders: string[];
  /** The browser: dodo's own Chrome window, or your Chrome through the Playwright Extension. */
  browser?: { mode?: 'window' | 'extension'; token?: string };
}

export const VERSION = '0.1.0';
export const DEFAULT_PROJECT_ID = 'dodo-512722';
export const DEFAULT_REGION = 'europe-west1';

/** `DODO_HOME` overrides the state directory (tests and the emulator pair use a scratch one). */
export const home = () => process.env.DODO_HOME ?? path.join(os.homedir(), '.dodo');
export const configPath = () => path.join(home(), 'config.json');
export const logPath = () => path.join(home(), 'daemon.log');
/** Task folders for tasks that name no folder of their own. */
export const workRoot = () => path.join(home(), 'work');
/** The profile of dodo's own Chrome window: its logins, kept between runs. */
export const chromeProfile = () => path.join(home(), 'chrome');

export function readConfig(): CliConfig | undefined {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as CliConfig;
  } catch {
    return undefined;
  }
}

export function writeConfig(config: CliConfig) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function requireConfig(): CliConfig {
  const config = readConfig();
  if (!config) {
    throw new Error(
      'This Mac is not paired. Run `pnpm dodo login <code>` with a code from Settings.',
    );
  }
  return config;
}

/** `~/code` → `/Users/you/code`, resolved and without a trailing slash. */
export function expandFolder(p: string): string {
  const expanded =
    p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return path.resolve(expanded);
}
