import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { home, workRoot } from './config.js';

/**
 * The worker on a Mac runs inside Anthropic's sandbox runtime (Seatbelt on macOS, bubblewrap on
 * Linux), the whole process, not just the agent's shell commands. What it gets:
 *
 *   reads    everything except your home folder; inside it only the task folders you added,
 *            the daemon's work folder and whatever the worker itself needs (node, its bundle)
 *   writes   the task folders, the work folder and the temp folder
 *   network  through the runtime's proxy only: the Firebase hosts the worker talks to, GitHub
 *            and the package registries; any other host is asked of the control plane, which
 *            applies the task's policy (allowed hosts, allow rules, the approval you just gave)
 *
 * The daemon itself stays outside, with the device sign-in in the Keychain; the worker only
 * ever holds the run token.
 */

export interface SandboxInputs {
  /** The user's home folder: denied, except for the carve-outs below. */
  homeDir: string;
  /** ~/.dodo (or DODO_HOME): denied too, it holds the pairing and, without a Keychain, the sign-in. */
  stateDir: string;
  workRoot: string;
  /** Task folders the user added, expanded. */
  folders: string[];
  /** Read-only paths the worker needs: node, the worker bundle. */
  readable: string[];
  tmpDir: string;
  projectId: string;
  region: string;
  emulatorHost?: string;
}

/** Hosts every run needs, whatever the task: the control plane, GitHub and the registries. */
export function workerHosts(projectId: string, region: string, emulatorHost?: string): string[] {
  return [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    `${region}-${projectId}.cloudfunctions.net`,
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'registry.npmjs.org',
    'pypi.org',
    'files.pythonhosted.org',
    ...(emulatorHost ? ['localhost', emulatorHost] : []),
  ];
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function sandboxConfig(i: SandboxInputs): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: workerHosts(i.projectId, i.region, i.emulatorHost),
      deniedDomains: [],
    },
    filesystem: {
      denyRead: uniq([i.homeDir, i.stateDir]),
      allowRead: uniq([i.workRoot, ...i.folders, ...i.readable]),
      allowWrite: uniq([i.workRoot, ...i.folders, i.tmpDir]),
      // The temp folder may hold the state dir (tests); its files stay out of reach either way.
      denyWrite: [
        path.join(i.stateDir, 'config.json'),
        path.join(i.stateDir, 'auth.json'),
        path.join(i.stateDir, 'daemon.log'),
      ],
    },
  };
}

/** The config for this Mac as paired: folders from the config file, paths from the environment. */
export function sandboxInputsFor(
  config: { firebase: { projectId: string }; region: string; emulatorHost?: string },
  folders: string[],
  workerEntry: string,
): SandboxInputs {
  return {
    homeDir: os.homedir(),
    stateDir: home(),
    workRoot: workRoot(),
    folders,
    // The runtime's own helpers run inside the sandbox on Linux (they live under node_modules,
    // which is usually under the home folder).
    readable: [path.dirname(workerEntry), path.dirname(process.execPath), runtimePackageDir()],
    tmpDir: os.tmpdir(),
    projectId: config.firebase.projectId,
    region: config.region,
    emulatorHost: config.emulatorHost,
  };
}

function runtimePackageDir(): string {
  const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'));
  return path.dirname(path.dirname(entry));
}

export interface SandboxReport {
  /** 'on' | 'off' (DODO_SANDBOX=off) | 'unavailable' (platform or missing tools). */
  state: 'on' | 'off' | 'unavailable';
  problems: string[];
  warnings: string[];
}

/** Can this machine sandbox a worker? `DODO_SANDBOX=off` turns it off for development, loudly. */
export function sandboxReport(): SandboxReport {
  if (process.env.DODO_SANDBOX === 'off') {
    return {
      state: 'off',
      problems: [],
      warnings: ['DODO_SANDBOX=off: the worker runs unsandboxed'],
    };
  }
  if (!SandboxManager.isSupportedPlatform()) {
    return {
      state: 'unavailable',
      problems: [`no sandbox for ${process.platform}; dodo runs tasks on macOS and Linux`],
      warnings: [],
    };
  }
  const deps = SandboxManager.checkDependencies();
  const hint = process.platform === 'linux' ? ' (apt-get install bubblewrap socat ripgrep)' : '';
  return {
    state: deps.errors.length ? 'unavailable' : 'on',
    problems: deps.errors.map((e) => `${e}${hint}`),
    warnings: deps.warnings,
  };
}

export type AskHost = (host: string, port: number | undefined) => Promise<boolean | string>;

/**
 * Start the runtime's proxies with this config. `ask` decides hosts the allowlist does not cover:
 * `true` allows, a string denies with that reason (what the sandboxed client sees on its 403).
 */
let baseConfig: SandboxRuntimeConfig | undefined;

export async function startSandbox(config: SandboxRuntimeConfig, ask: AskHost): Promise<void> {
  baseConfig = config;
  await SandboxManager.initialize(config, async ({ host, port }) => {
    const verdict = await ask(host, port);
    if (verdict === true) return true;
    const reason = typeof verdict === 'string' ? verdict : 'denied';
    return SandboxManager.askCallbackDenyReason ? { allow: false, reason } : false;
  });
}

export async function stopSandbox(): Promise<void> {
  baseConfig = undefined;
  await SandboxManager.reset().catch(() => {});
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface SandboxedOptions {
  /**
   * Route loopback through the sandbox's proxy. The runtime exempts loopback from its proxy
   * (`NO_PROXY=localhost,127.0.0.1,…`); inside the Linux network namespace a direct loopback
   * connection goes nowhere, so with the emulators on the host the exemption has to go. Only the
   * proxy's own address stays exempt: node proxies `http.request` too, and grpc-js reaches the
   * proxy with one, which the proxy would otherwise be asked to tunnel to itself.
   */
  proxyLoopback?: boolean;
  /**
   * Let the worker reach servers on this machine: the browser server the daemon runs for it.
   * Seatbelt bakes it into the profile at wrap time from the runtime's current config, so the
   * config is switched for the wrap and switched back; the egress allowlist stays as it was.
   */
  localBinding?: boolean;
}

/** `node worker.js` as an argv to spawn, inside the sandbox; `commandId` keys its violations. */
export async function sandboxedArgv(
  argv: string[],
  cwd: string,
  commandId: string,
  options: SandboxedOptions = {},
): Promise<string[]> {
  const command = argv.map(quote).join(' ');
  const bypass = options.proxyLoopback ? proxyBypass(sandboxProxyPort()) : undefined;
  const inner = bypass
    ? `env -u no_grpc_proxy NO_PROXY=${quote(bypass)} no_proxy=${quote(bypass)} ${command}`
    : command;
  const base = baseConfig;
  if (options.localBinding && base)
    SandboxManager.updateConfig({ ...base, network: { ...base.network, allowLocalBinding: true } });
  try {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      inner,
      undefined,
      undefined,
      undefined,
      cwd,
      { commandId, commandText: command },
    );
    return wrapped.argv;
  } finally {
    if (options.localBinding && base) SandboxManager.updateConfig(base);
  }
}

/** Where the sandboxed command finds the proxy: a fixed relay port on Linux, the proxy itself elsewhere. */
function sandboxProxyPort(): number | undefined {
  return process.platform === 'linux' ? 3128 : SandboxManager.getProxyPort();
}

/**
 * A `NO_PROXY` that exempts only the proxy at `localhost:port`, in the spellings node's
 * `http.request` (`::1:port`) and its `fetch` (`[::1]:port`) compare against.
 */
export function proxyBypass(port: number | undefined): string | undefined {
  if (!port) return undefined;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].map((h) => `${h}:${port}`).join(',');
}

/** What the sandbox refused during a command, one line each, and release the command's mounts. */
export function finishSandboxed(commandId: string): string[] {
  const lines = SandboxManager.getSandboxViolationStore()
    .getViolationsForCommand(commandId)
    .map((v) => v.line);
  SandboxManager.cleanupAfterCommand();
  return lines;
}
