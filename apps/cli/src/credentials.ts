import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { home } from './config.js';

/**
 * Where the device sign-in lives. On a Mac it is a Keychain item, so only the daemon's user can
 * read it and sandboxed agent processes (next PR) cannot. Elsewhere, and when
 * `DODO_CREDENTIAL_STORE=file` (the emulator pair in CI), a 0600 file under ~/.dodo.
 */
export interface CredentialStore {
  load(): string | undefined;
  save(value: string): void;
  clear(): void;
  readonly kind: 'keychain' | 'file';
}

const SERVICE = 'dev.dodo.device';
const ACCOUNT = 'dodo';

class KeychainStore implements CredentialStore {
  readonly kind = 'keychain' as const;
  load() {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
    } catch {
      return undefined;
    }
  }
  save(value: string) {
    // -U updates in place; the value goes in as an argument, which stays off disk.
    execFileSync(
      'security',
      ['add-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-U', '-w', value],
      {
        stdio: 'ignore',
      },
    );
  }
  clear() {
    try {
      execFileSync('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE], {
        stdio: 'ignore',
      });
    } catch {
      // nothing stored
    }
  }
}

class FileStore implements CredentialStore {
  readonly kind = 'file' as const;
  private readonly file = path.join(home(), 'auth.json');
  load() {
    try {
      return readFileSync(this.file, 'utf8');
    } catch {
      return undefined;
    }
  }
  save(value: string) {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, value, { mode: 0o600 });
  }
  clear() {
    rmSync(this.file, { force: true });
  }
}

export function credentialStore(): CredentialStore {
  const forced = process.env.DODO_CREDENTIAL_STORE;
  if (forced === 'file') return new FileStore();
  if (forced === 'keychain' || process.platform === 'darwin') return new KeychainStore();
  return new FileStore();
}
