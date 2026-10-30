import { execFileSync } from 'node:child_process';
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
import { agentInstalled, installAgent, restartAgent, uninstallAgent } from './launchd.js';
import {
  checkLocalModel,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_LOCAL_MODEL_URL,
  DEFAULT_SHARED_PORT,
  isLoopback,
  normaliseBaseUrl,
} from './local-model.js';
import {
  connectLocal,
  type LocalMcpConfig,
  refreshServer,
  reportError,
  syncServers,
} from './mcp.js';
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
  dodo mcp               the MCP servers this Mac runs for the agent (shown in the Tools view)
  dodo mcp add <name> [--title "Outlook"] [--env KEY=VALUE]... -- <command> [args...]
  dodo mcp add <name> --url http://localhost:3000/mcp [--header "Authorization: Bearer …"]
                         add one (e.g. dodo mcp add outlook -- npx -y outlook-mcp); it starts
                         once here, so a sign-in it asks for shows up in this terminal
  dodo mcp test <name>   start it here and list its tools (sign in again, if it asks)
  dodo mcp remove <name>
  dodo browser           how tasks get a browser: dodo's own Chrome window by default (log in
                         there once), or your everyday Chrome through the Playwright Extension
  dodo browser install   open the Playwright Extension in the Web Store (optional, one click)
  dodo browser connect <token>
                         the extension's token, so Chrome never asks to allow the agent
  dodo browser use window|extension
  dodo model             the local model tasks can use (Model: Local model, your Mac)
  dodo model set --mlx <repo>
                         an MLX model from the Hugging Face cache, started on demand: the
                         daemon runs mlx_lm.server on the first request and stops it when idle
                         (--idle <minutes>, default 10); other apps can share it at
                         http://localhost:${DEFAULT_SHARED_PORT}/v1
  dodo model set [url] [--model <name>] [-- <command>]
                         any OpenAI-compatible server on this Mac (default
                         ${DEFAULT_LOCAL_MODEL_URL}); with a command, started on demand too
  dodo model test        ask it to call a tool, to see that the agent can work with it
  dodo model off         no local model on this Mac
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

/** Values of a flag given more than once (`--env A=1 --env B=2`). */
function many(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === `--${flag}` && argv[i + 1] !== undefined) out.push(argv[++i] as string);
    else if (a.startsWith(`--${flag}=`)) out.push(a.slice(flag.length + 3));
  }
  return out;
}

const SLUG = /^[a-z][a-z0-9-]{0,23}$/;

/** Local MCP servers: config on this Mac, documents for the Tools view, tools fetched here. */
async function mcp(
  action: string | undefined,
  slug: string | undefined,
  argv: string[],
  command: string[],
) {
  const config = requireConfig();
  const servers = config.mcp ?? [];
  const flags = parse(argv).flags;
  const save = async (next: LocalMcpConfig[]) => {
    config.mcp = next;
    writeConfig(config);
    const clients = connect(config, credentialStore());
    await currentUser(clients);
    await syncServers(clients.db, config.deviceId, next);
    return clients;
  };
  const tryOut = async (s: LocalMcpConfig, db: Parameters<typeof refreshServer>[0]) => {
    console.log(`Starting ${s.slug}… (if it asks you to sign in, do that now)`);
    try {
      // Its own output goes to this terminal: a device code or sign-in link shows up here.
      const client = await connectLocal(s, (line) => console.log(`  ${line}`));
      const n = await refreshServer(db, config.deviceId, s, client);
      await client.close();
      console.log(`${s.slug}: ${n} tools. They are in the Tools view now.`);
    } catch (err) {
      const message = (err as Error).message;
      await reportError(db, config.deviceId, s.slug, message);
      console.log(`${s.slug} did not start: ${message}`);
    }
  };
  const restart = () =>
    console.log(
      restartAgent()
        ? 'Restarted the background daemon so runs get it.'
        : 'Restart the daemon (pnpm dodo daemon) so runs get it.',
    );

  if (action === 'add') {
    if (!slug || !SLUG.test(slug))
      throw new Error(
        'Usage: dodo mcp add <name> -- <command> [args...]  (name: lowercase, e.g. outlook)',
      );
    const url = str(flags.url);
    if (!url && command.length === 0)
      throw new Error('Give the command after --, e.g. dodo mcp add outlook -- npx -y outlook-mcp');
    const env = Object.fromEntries(
      many(argv, 'env').map((kv) => {
        const i = kv.indexOf('=');
        if (i < 1) throw new Error(`--env ${kv}: use KEY=VALUE`);
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const headers = Object.fromEntries(
      many(argv, 'header').map((h) => {
        const i = h.indexOf(':');
        if (i < 1) throw new Error(`--header ${h}: use "Name: value"`);
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      }),
    );
    const entry: LocalMcpConfig = JSON.parse(
      JSON.stringify({
        slug,
        name: str(flags.title),
        ...(url
          ? { url, headers: Object.keys(headers).length ? headers : undefined }
          : { command: command[0], args: command.slice(1) }),
        env: Object.keys(env).length ? env : undefined,
      }),
    );
    const clients = await save([...servers.filter((s) => s.slug !== slug), entry]);
    await tryOut(entry, clients.db);
    restart();
    return;
  }
  if (action === 'remove') {
    if (!slug || !servers.some((s) => s.slug === slug))
      throw new Error(`No MCP server ${slug ?? ''}`);
    await save(servers.filter((s) => s.slug !== slug));
    console.log(`Removed ${slug}.`);
    restart();
    return;
  }
  if (action === 'test') {
    const s = servers.find((x) => x.slug === slug);
    if (!s) throw new Error(`No MCP server ${slug ?? ''}; dodo mcp lists them`);
    const clients = connect(config, credentialStore());
    await currentUser(clients);
    await tryOut(s, clients.db);
    return;
  }
  if (servers.length === 0)
    console.log('No MCP servers on this Mac. Add one: dodo mcp add outlook -- npx -y <package>');
  for (const s of servers)
    console.log(
      `${s.slug}${s.name ? ` (${s.name})` : ''}: ${s.url ?? [s.command, ...(s.args ?? [])].join(' ')}${s.env ? `  env: ${Object.keys(s.env).join(', ')}` : ''}`,
    );
}

/** The agent's browser is your Chrome: the extension does the driving, the token skips its dialog. */
async function browser(action: string | undefined, token: string | undefined) {
  const config = requireConfig();
  if (action === 'install') {
    openInBrowser(EXTENSION_URL);
    console.log(`Opening ${EXTENSION_URL}\nClick "Add to Chrome"; the daemon notices on its own.`);
    return;
  }
  if (action === 'connect') {
    if (!token?.trim())
      throw new Error(
        "Usage: dodo browser connect <token>\n  Open the Playwright Extension from Chrome's toolbar and copy the token it shows.",
      );
    config.browser = { token: token.trim() };
    writeConfig(config);
  } else if (action === 'use') {
    if (token !== 'window' && token !== 'extension')
      throw new Error('Usage: dodo browser use window|extension');
    config.browser = { ...config.browser, mode: token };
    writeConfig(config);
  } else if (action === 'forget') {
    config.browser = undefined;
    writeConfig(config);
  } else if (action !== undefined)
    throw new Error('Usage: dodo browser [install|connect <token>|use window|extension|forget]');
  const r = browserReport(config);
  if (r.state === 'ready') {
    console.log(
      r.mode === 'extension'
        ? `Ready: your Chrome (profile ${r.profiles.join(', ')} has the extension).`
        : "Ready: dodo's own Chrome window.",
    );
    for (const w of r.warnings) console.log(`  ${w}`);
  } else {
    console.log('Not ready:');
    for (const p of r.problems) console.log(`  ${p}`);
  }
}

/** The command's program as an absolute path: the launchd daemon's PATH is short. */
function resolveProgram(command: string[]): string[] {
  const [program, ...args] = command;
  if (!program || program.includes('/')) return command;
  try {
    const found = execFileSync('/bin/sh', ['-lc', `command -v ${JSON.stringify(program)}`], {
      encoding: 'utf8',
    }).trim();
    return found ? [found, ...args] : command;
  } catch {
    throw new Error(`${program} is not installed (or not on your PATH).`);
  }
}

async function model(
  action: string | undefined,
  url: string | undefined,
  flags: Flags,
  rest: string[],
) {
  const config = requireConfig();
  if (action === 'set') {
    const base = normaliseBaseUrl(url ?? DEFAULT_LOCAL_MODEL_URL);
    if (!isLoopback(base))
      throw new Error(
        `The local model must run on this Mac (localhost), not ${new URL(base).host}: the worker's sandbox reaches only this machine.`,
      );
    const mlx = str(flags.mlx);
    const port = new URL(base).port || '8080';
    const command = mlx
      ? ['mlx_lm.server', '--model', mlx, '--port', port]
      : rest.length
        ? rest
        : undefined;
    const name = str(flags.model) ?? mlx;
    const idle = Number(str(flags.idle));
    const shared = Number(str(flags.port));
    config.localModel = {
      url: base,
      ...(name ? { model: name } : {}),
      ...(command ? { command: resolveProgram(command) } : {}),
      ...(idle > 0 ? { idleMinutes: idle } : {}),
      ...(shared > 0 ? { port: shared } : {}),
    };
    writeConfig(config);
    describeModel(config.localModel);
    if (agentInstalled()) {
      restartAgent();
      console.log('Restarted the background daemon so it picks this up.');
    } else console.log('Restart `dodo daemon` if it is running, so it picks this up.');
    if (command) return;
  } else if (action === 'off') {
    config.localModel = undefined;
    writeConfig(config);
    console.log('No local model on this Mac any more.');
    if (agentInstalled()) restartAgent();
    return;
  } else if (action !== undefined && action !== 'test') {
    throw new Error(
      'Usage: dodo model [set [url] [--model <name>] [--mlx <repo> | -- <command>] [--idle <min>] [--port <n>]|test|off]',
    );
  }
  if (!config.localModel) {
    console.log(
      'No local model set up. For an MLX model in your Hugging Face cache:\n  dodo model set --mlx mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit\n(see docs/LOCAL_MODEL.md)',
    );
    return;
  }
  if (action !== 'test') describeModel(config.localModel);
  // On demand: test through the daemon's endpoint, which starts the server if it must.
  const target = config.localModel.command?.length
    ? {
        ...config.localModel,
        url: `http://localhost:${config.localModel.port ?? DEFAULT_SHARED_PORT}/v1`,
      }
    : config.localModel;
  console.log(`Checking ${target.url} (the first call loads the model, which can take a minute)…`);
  const r = await checkLocalModel(target);
  if (r.models.length) console.log(`  the server lists: ${r.models.join(', ')}`);
  if (!r.ok) {
    console.log(
      `  not working: ${r.problem}${config.localModel.command?.length ? ' (is the daemon running? see ~/.dodo/model.log)' : ''}`,
    );
    return;
  }
  console.log(
    r.toolCalls
      ? `  ok: it called a tool (${r.seconds}s). Pick "Local model (your Mac)" as a task's model.`
      : `  it answered in ${r.seconds}s but did not call the tool: the agent needs a model and server with tool calling.`,
  );
}

function describeModel(m: NonNullable<CliConfig['localModel']>) {
  console.log(`Local model: ${m.model ?? "the server's default"} at ${m.url}`);
  if (m.command?.length) {
    console.log(
      `  on demand: the daemon starts \`${m.command.join(' ')}\` on the first request and stops it after ${m.idleMinutes ?? DEFAULT_IDLE_MINUTES} idle minutes`,
    );
    console.log(
      `  shared endpoint for dodo and other apps: http://localhost:${m.port ?? DEFAULT_SHARED_PORT}/v1`,
    );
  } else console.log('  you keep the server running yourself');
}

/** Open a page in the user's default browser (macOS only; elsewhere the URL is printed). */
function openInBrowser(url: string) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('open', [url], { stdio: 'ignore' });
  } catch {
    // printed by the caller
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
  // Optional: a task only gets a browser when this is ready, so it is not a failure.
  console.log(
    `${chrome.state === 'ready' ? 'ok  ' : 'info'} browser: ${
      chrome.state === 'ready'
        ? `${chrome.mode === 'extension' ? `your Chrome (profile ${chrome.profiles.join(', ')})` : "dodo's own Chrome window"}${chrome.warnings.length ? `; ${chrome.warnings.join('; ')}` : ''}`
        : `${chrome.problems.join('; ')} (optional: tasks that use a browser)`
    }`,
  );
  // Optional too: only tasks set to the local model need it.
  if (config.localModel?.command?.length) {
    // On demand: not started here (it holds the model in memory); `dodo model test` does.
    const program = config.localModel.command[0] as string;
    ok(
      `local model on demand (${program.split('/').pop()})`,
      !program.includes('/') || existsSync(program),
      'dodo model test starts it and checks tool calls',
    );
  } else if (config.localModel) {
    const r = await checkLocalModel(config.localModel);
    console.log(
      `${r.ok && r.toolCalls ? 'ok  ' : 'info'} local model at ${config.localModel.url}: ${
        r.ok
          ? r.toolCalls
            ? `answers with tool calls (${r.seconds}s)`
            : 'answers, but without tool calls'
          : r.problem
      }`,
    );
  } else console.log('info local model: none (optional: dodo model set)');
  // Informational: setup installs it, so its absence is not a failure.
  if (process.platform === 'darwin')
    console.log(
      `${agentInstalled() ? 'ok  ' : 'info'} launchd agent: ${agentInstalled() ? 'installed' : 'not installed (dodo setup or dodo daemon install)'}`,
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
  if (existing) {
    console.log(`Already paired as "${existing.name}"; keeping that pairing.`);
    // No code needed any more: a first argument that is a folder is one.
    if (code && (code.includes('/') || code.startsWith('~') || existsSync(code)))
      folderArgs = [code, ...folderArgs];
  } else {
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

async function main(full: string[]): Promise<number> {
  // Everything after `--` is a command line of its own (`dodo mcp add x -- npx -y pkg --flag`).
  const dashes = full.indexOf('--');
  const argv = dashes >= 0 ? full.slice(0, dashes) : full;
  const rest = dashes >= 0 ? full.slice(dashes + 1) : [];
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
    case 'mcp':
      await mcp(sub, third, argv, rest);
      return 0;
    case 'model':
      await model(sub, third, flags, rest);
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
