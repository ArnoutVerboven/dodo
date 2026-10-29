import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, logPath } from './config.js';

/** A launchd agent keeps the daemon running while you are logged in, and restarts it if it dies. */
const LABEL = 'dev.dodo.daemon';
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const escapeXml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

export function installAgent(cliEntry: string) {
  if (process.platform !== 'darwin') throw new Error('launchd agents only exist on macOS');
  mkdirSync(path.dirname(plistPath()), { recursive: true });
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  if (process.env.DODO_HOME) env.DODO_HOME = process.env.DODO_HOME;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cliEntry)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${escapeXml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath())}</string>
</dict></plist>
`;
  uninstallAgent();
  writeFileSync(plistPath(), plist, { mode: 0o644 });
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath()], {
    stdio: 'inherit',
  });
  return plistPath();
}

export function uninstallAgent() {
  if (!existsSync(plistPath())) return false;
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath()], {
      stdio: 'ignore',
    });
  } catch {
    // not loaded
  }
  rmSync(plistPath(), { force: true });
  return true;
}

export const agentInstalled = () => existsSync(plistPath());

/** Restart the background daemon so it reads its config again; false when none is installed. */
export function restartAgent(): boolean {
  if (!agentInstalled()) return false;
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${LABEL}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
