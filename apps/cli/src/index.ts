import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_PROTOCOL,
  type DeviceRegisterResponse,
  deviceChoice,
  isDeviceOnline,
  paths,
} from '@dodo/core';
import { initializeApp } from 'firebase/app';
import { signInWithCustomToken } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connect, currentUser } from './auth.js';
import { browserReport, EXTENSION_URL } from './browser.js';
import {
  type CliConfig,
  configPath,
  DEFAULT_PROJECT_ID,
  DEFAULT_REGION,
  expandFolder,
  logPath,
  readConfig,
  requireConfig,
  VERSION,
  writeConfig,
} from './config.js';
import { credentialStore } from './credentials.js';
import { runDaemon, workerEntry } from './daemon.js';
import { agentInstalled, installAgent, uninstallAgent } from './launchd.js';
import { sandboxReport } from './sandbox.js';

const HELP = `dodo ${VERSION}: run dodo tasks on this Mac

  dodo setup <code> [folder...] [--name "My Mac"] [--foreground]
                         everything below in one go: pair, add the folders, check, and keep
                         the daemon running in the background (launchd on macOS)
  dodo login <code> [--name "My Mac"] [--project <id>] [--emulator]
                         pair this Mac with the code from Settings › Your Macs
  dodo daemon [--once]   wait for runs addressed to this Mac and execute them
  dodo daemon install    keep the daemon running in the background (launchd), start at login
  dodo daemon uninstall
  dodo folders [add|remove <path>]
                         folders the agent may work in on this Mac
  dodo browser [connect <token>|forget]
                         let the agent use your own Chrome: install the Playwright Extension,
                         then paste the token from the extension's page here
  dodo status            this Mac as the server sees it
  dodo doctor            check node, pairing, sign-in, the worker build, the sandbox and Chrome
  dodo logout            forget the pairing on this Mac (revoke it in Settings too)
`;

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[k as string] = inline;
      else if (next !== undefined && !next.startsWith('--')) {
        flags[k as string] = next;
        i++;
      } else flags[k as string] = true;
    } else args.push(a);
  }
  return { args, flags };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

async function login(code: string | undefined, flags: Flags) {
  if (!code) throw new Error('Usage: dodo login <code>  (the code is in Settings › Your Macs)');
  const existing = readConfig();
  if (existing) {
    throw new Error(
      `This Mac is already paired as "${existing.name}". Run \`dodo logout\` first to pair again.`,
    );
  }
  const emulator = flags.emulator === true;
  const projectId = str(flags.project) ?? (emulator ? 'demo-dodo' : DEFAULT_PROJECT_ID);
  const emulatorHost = emulator ? (process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1') : undefined;
  const name = str(flags.name) ?? os.hostname().replace(/\.local$/, '');

  // No sign-in yet, so no API key yet: callables only need the project id.
  const bootstrap = initializeApp({ projectId }, 'dodo-login');
  const fns = getFunctions(bootstrap, DEFAULT_REGION);
  if (emulatorHost) connectFunctionsEmulator(fns, emulatorHost, 5001);
  const res = await httpsCallable<
    unknown,
    DeviceRegisterResponse & { firebase?: CliConfig['firebase'] }
  >(
    fns,
    'deviceRegister',
  )({ code, name, platform: process.platform, version: VERSION, protocol: DEVICE_PROTOCOL });
  const firebase = res.data.firebase ?? { apiKey: 'demo-key', projectId };

  const config: CliConfig = {
    deviceId: res.data.deviceId,
    name,
    firebase,
    region: DEFAULT_REGION,
    emulatorHost,
    folders: [],
  };
  const store = credentialStore();
  const clients = connect(config, store);
  await signInWithCustomToken(clients.auth, res.data.token);
  writeConfig(config);
  console.log(
    `Paired as "${name}" (${deviceChoice(config.deviceId)}). Sign-in kept in the ${store.kind}.`,
  );
  console.log(
    'Next: `pnpm dodo folders add ~/code` for the folders the agent may use, then `pnpm dodo daemon`.',
  );
}

async function status() {
  const config = requireConfig();
  const store = credentialStore();
  const clients = connect(config, store);
  await currentUser(clients);
  const snap = await getDoc(doc(clients.db, paths.device(config.deviceId)));
  if (!snap.exists()) {
    console.log(`"${config.name}" was removed in Settings. Run \`dodo logout\`, then pair again.`);
    return;
  }
  const d = snap.data();
  const online = d.state === 'approved' && isDeviceOnline(d.lastSeen);
  // A revoked Mac may still read its own document, but no runs.
  const queued =
    d.state === 'approved'
      ? await getDocs(
          query(
            collection(clients.db, paths.runs()),
            where('device', '==', deviceChoice(config.deviceId)),
            where('state', '==', 'queued'),
          ),
        ).then((q) => String(q.size))
      : '(revoked in Settings)';
  console.log(`${config.name} (${deviceChoice(config.deviceId)})`);
  console.log(`  state:      ${d.state}${online ? ', daemon online' : ', daemon offline'}`);
  console.log(`  last seen:  ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never'}`);
  console.log(`  working on: ${d.currentRunId ?? 'nothing'}`);
  console.log(`  queued:     ${queued} run(s) waiting for this Mac`);
  console.log(`  folders:    ${config.folders.join(', ') || '(none; add with dodo folders add)'}`);
  console.log(
    `  browser:    ${browserReport(config).state === 'ready' ? 'your Chrome' : 'none (dodo browser)'}`,
  );
  console.log(`  launchd:    ${agentInstalled() ? 'installed' : 'not installed'}`);
  console.log(`  config:     ${configPath()}`);
  console.log(`  log:        ${logPath()}`);
}

async function folders(action: string | undefined, target: string | undefined) {
  const config = requireConfig();
  if (action === 'add' || action === 'remove') {
    if (!target) throw new Error(`Usage: dodo folders ${action} <path>`);
    const folder = expandFolder(target);
    if (action === 'add' && !existsSync(folder)) throw new Error(`${folder} does not exist`);
    const next = new Set(config.folders.map(expandFolder));
    if (action === 'add') next.add(folder);
    else next.delete(folder);
    config.folders = [...next];
    writeConfig(config);
    // Tell the server too, so the task form can offer these folders.
    const store = credentialStore();
    const clients = connect(config, store);
    await currentUser(clients);
    await updateDoc(doc(clients.db, paths.device(config.deviceId)), {
      folders: config.folders,
      updatedAt: Date.now(),
    }).catch(() => console.log('(saved locally; the daemon reports it on its next heartbeat)'));
  }
  if (config.folders.length === 0)
    console.log('No folders yet. The agent works in a scratch folder under ~/.dodo/work.');
  for (const f of config.folders) console.log(f);
}

/** The agent's browser is your Chrome: the extension does the driving, the token skips its dialog. */
async function browser(action: string | undefined, token: string | undefined) {
  const config = requireConfig();
  if (action === 'connect') {
    if (!token?.trim())
      throw new Error(
        `Usage: dodo browser connect <token>\n  Install the extension (${EXTENSION_URL}), open it from Chrome's toolbar and copy the token it shows.`,
      );
    config.browser = { token: token.trim() };
    writeConfig(config);
  } else if (action === 'forget') {
    config.browser = undefined;
    writeConfig(config);
  } else if (action !== undefined) throw new Error('Usage: dodo browser [connect <token>|forget]');
  const r = browserReport(config);
  if (r.state === 'ready')
    console.log(
      `Ready: Chrome profile ${r.profiles.join(', ')} with the extension, token stored. Restart the daemon (pnpm dodo daemon install) to pick it up.`,
    );
  else {
    console.log('Not ready:');
    for (const p of r.problems) console.log(`  ${p}`);
  }
}

/** Returns whether every check passed. */
async function doctor(): Promise<boolean> {
  let all = true;
  const ok = (label: string, good: boolean, note = '') => {
    all &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${label}${note ? `: ${note}` : ''}`);
  };
  const major = Number(process.versions.node.split('.')[0]);
  ok('node 22 or newer', major >= 22, process.versions.node);
  const config = readConfig();
  ok(
    'paired (config.json)',
    !!config,
    config ? `${config.name}, ${configPath()}` : 'run dodo login <code>',
  );
  const store = credentialStore();
  ok(`sign-in stored in the ${store.kind}`, !!store.load());
  const entry = workerEntry();
  ok('worker built', existsSync(entry), entry);
  const sandbox = sandboxReport();
  ok(
    'sandbox for the worker',
    sandbox.state === 'on',
    sandbox.state === 'on'
      ? `${process.platform === 'darwin' ? 'Seatbelt' : 'bubblewrap'}${sandbox.warnings.length ? `; ${sandbox.warnings.join('; ')}` : ''}`
      : [...sandbox.problems, ...sandbox.warnings].join('; '),
  );
  if (!config) return false;
  try {
    const clients = connect(config, store);
    const user = await currentUser(clients);
    ok('sign-in valid', user.uid === `device:${config.deviceId}`, user.uid);
    const snap = await getDoc(doc(clients.db, paths.device(config.deviceId)));
    ok(
      'device approved in Settings',
      snap.exists() && snap.get('state') === 'approved',
      snap.get('state') ?? 'missing',
    );
  } catch (err) {
    ok('sign-in valid', false, (err as Error).message);
  }
  for (const f of config.folders) ok(`folder ${f}`, existsSync(expandFolder(f)));
  const chrome = browserReport(config);
  // Optional: the task form only offers "Your Chrome" when this is ready, so it does not fail.
  console.log(
    `${chrome.state === 'ready' ? 'ok  ' : 'info'} your Chrome: ${
      chrome.state === 'ready'
        ? `profile ${chrome.profiles.join(', ')}, token stored`
        : `${chrome.problems.join('; ')} (optional: tasks that need your logins)`
    }`,
  );
  if (process.platform === 'darwin')
    ok(
      'launchd agent',
      agentInstalled(),
      agentInstalled() ? 'installed' : 'not installed (dodo daemon install)',
    );
  return all;
}

/** The whole setup in one command: pair (once), add the folders, check, run the daemon. */
async function setup(
  code: string | undefined,
  folderArgs: string[],
  flags: Flags,
): Promise<number> {
  const existing = readConfig();
  if (existing) console.log(`Already paired as "${existing.name}"; keeping that pairing.`);
  else {
    if (!code)
      throw new Error(
        'Usage: dodo setup <code> [folder...]  (the code is in Settings › Your Macs)',
      );
    await login(code, flags);
  }
  for (const f of folderArgs) await folders('add', f);
  console.log('');
  const healthy = await doctor();
  console.log('');
  if (!healthy) {
    console.log('Fix the FAIL lines above, then run `pnpm dodo setup` again (no code needed).');
    return 1;
  }
  const config = requireConfig();
  if (flags.foreground === true || process.platform !== 'darwin') {
    console.log('Setup complete. Starting the daemon here; stop it with Ctrl-C.');
    const reason = await runDaemon(config, {});
    return reason === 'once' ? 0 : 1;
  }
  const plist = installAgent(fileURLToPath(import.meta.url));
  console.log(`Setup complete. The daemon runs in the background and starts at login (${plist}).`);
  console.log(`Log: ${logPath()}. Check it any time with \`pnpm dodo status\`.`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { args, flags } = parse(argv);
  const [cmd, sub, third] = args;
  switch (cmd) {
    case 'setup':
      return setup(sub, args.slice(2), flags);
    case 'login':
      await login(sub, flags);
      return 0;
    case 'daemon': {
      if (sub === 'install') {
        const plist = installAgent(fileURLToPath(import.meta.url));
        console.log(`Installed ${plist}. It starts at login; log: ${logPath()}`);
        return 0;
      }
      if (sub === 'uninstall') {
        console.log(
          uninstallAgent() ? 'Removed the launchd agent.' : 'No launchd agent installed.',
        );
        return 0;
      }
      const config = requireConfig();
      const reason = await runDaemon(config, { once: flags.once === true });
      return reason === 'once' ? 0 : 1;
    }
    case 'status':
      await status();
      return 0;
    case 'folders':
      await folders(sub, third);
      return 0;
    case 'browser':
      await browser(sub, third);
      return 0;
    case 'doctor':
      await doctor();
      return 0;
    case 'logout': {
      credentialStore().clear();
      const config = readConfig();
      if (config) {
        const { rmSync } = await import('node:fs');
        rmSync(configPath(), { force: true });
        console.log(
          `Forgot the pairing for "${config.name}". Revoke it in Settings › Your Macs as well.`,
        );
      } else console.log('Nothing to forget.');
      return 0;
    }
    case 'version':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd === undefined || cmd === 'help' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error((err as Error).message ?? String(err));
    process.exit(1);
  },
);
