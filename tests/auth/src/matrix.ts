/**
 * The auth test matrix: which login methods to try on which kind of device, the task each case
 * becomes, how a finished case is read, and the overview it ends up in. Pure functions only, so
 * they are unit tested for free in `pnpm -r test`; run.ts does the talking to Firestore.
 */

/** Where a case runs: the paired Mac (its dodo Chrome window) or remote (headless Chromium). */
export type Env = 'local' | 'remote';
export const ENVS: readonly Env[] = ['local', 'remote'];

/** One login method on one site (sites.ts, or a file passed with --targets). */
export interface Method {
  /** Short id used on the command line: `itsme`, `google`, `password`. */
  id: string;
  label: string;
  /** The page to start from. */
  site: string;
  /** Vault entry the agent may use (approved up front for the test task). */
  vault?: string;
  /** Without `vault`: use the vault entry for the first of these sites you have one for. */
  vaultHosts?: string[];
  /** The login works without a vault entry (e.g. only your email or phone number is needed). */
  vaultOptional?: boolean;
  /** Hosts the login passes through: opened and submitted to without asking. */
  hosts: string[];
  /** What the second step looks like, so the agent and the report know what to expect. */
  mfa?: string;
  /** Extra instructions for the agent, e.g. "Choose itsme on the login page". */
  instructions?: string;
  /** Remote only: start from your stored Google session (use_google_session) instead of a fresh sign-in. */
  useGoogleSession?: boolean;
  /** Left out unless named with --only. */
  enabled?: boolean;
}

export interface Targets {
  methods: Method[];
}

export interface Case {
  id: string;
  method: Method;
  env: Env;
}

export interface Plan {
  only?: string[];
  envs?: Env[];
}

/** Every method × device the run covers, method by method so a login's two runs sit together. */
export function buildCases(targets: Targets, plan: Plan = {}): Case[] {
  const methods = targets.methods.filter((m) =>
    plan.only?.length ? plan.only.includes(m.id) : m.enabled !== false,
  );
  const unknown = (plan.only ?? []).filter((id) => !targets.methods.some((m) => m.id === id));
  if (unknown.length) throw new Error(`No method named ${unknown.join(', ')} in the targets`);
  const envs = plan.envs?.length ? plan.envs : ENVS;
  return methods.flatMap((method) =>
    envs
      // The stored Google session only exists remotely.
      .filter((env) => !(method.useGoogleSession && env === 'local'))
      .map((env) => ({ id: `${method.id}-${env}`, method, env })),
  );
}

/** Checks the targets and fills defaults; throws with every problem at once. */
export function parseTargets(raw: unknown): Targets {
  const problems: string[] = [];
  const list = (raw as { methods?: unknown })?.methods;
  if (!Array.isArray(list) || !list.length) throw new Error('targets: "methods" must be a list');
  const methods = list.map((m, i): Method => {
    const at = `methods[${i}]`;
    const v = (m ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
    const id = str('id') ?? '';
    if (!/^[a-z0-9-]+$/.test(id)) problems.push(`${at}.id: lowercase letters, digits, dashes`);
    const site = str('site') ?? '';
    let host = '';
    try {
      const u = new URL(site);
      if (u.protocol !== 'https:') throw new Error();
      host = u.hostname;
    } catch {
      problems.push(`${at}.site: an https URL`);
    }
    const hosts = Array.isArray(v.hosts) ? v.hosts.filter((h) => typeof h === 'string') : [];
    return {
      id,
      label: str('label') ?? id,
      site,
      vault: str('vault'),
      vaultHosts: Array.isArray(v.vaultHosts)
        ? v.vaultHosts.filter((h): h is string => typeof h === 'string')
        : undefined,
      vaultOptional: v.vaultOptional === true,
      hosts: [...new Set([host, ...hosts].filter(Boolean).map((h) => h.toLowerCase()))],
      mfa: str('mfa'),
      instructions: str('instructions'),
      useGoogleSession: v.useGoogleSession === true,
      enabled: v.enabled !== false,
    };
  });
  const ids = methods.map((m) => m.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) problems.push(`methods: "${dup}" appears twice`);
  if (problems.length) throw new Error(`targets:\n  ${problems.join('\n  ')}`);
  return { methods };
}

export const RESULT_LINE = /AUTH_RESULT:\s*(ok|failed)\s*(?:\|\s*(.*))?/i;

/** The task description: what the agent does, and how it reports. */
export function taskDescription(c: Case, opts: { reuseSessions?: boolean } = {}): string {
  const m = c.method;
  const lines = [
    'This is a login test. Only log in; do nothing else on the site: do not change settings, send, buy, accept or sign anything.',
    '',
    `Site: ${m.site}`,
    `Method: ${m.label}`,
  ];
  if (m.vault) {
    lines.push(
      `Credentials: vault entry \`${m.vault}\` (already approved for this task). Type its values with vault references; never ask me for a password.`,
    );
  }
  if (m.mfa) {
    lines.push(
      `Expected second step: ${m.mfa}. When the site asks for it, ask me with ask_user (with a screenshot when there is something to see, scan or pick) and wait for my answer.`,
    );
  }
  if (m.instructions) lines.push(m.instructions);
  if (m.useGoogleSession) {
    lines.push('Start by calling use_google_session, then check whether you are signed in.');
  } else if (c.env === 'remote' && m.hosts.some((h) => h.endsWith('google.com'))) {
    lines.push('Sign in fresh in this browser: do not call use_google_session.');
  }
  if (!opts.reuseSessions && !m.useGoogleSession) {
    lines.push(
      'This tests the whole login, so start signed out. If the site already shows you signed in (an account name, a "Log out" link, a dashboard), sign out first and check that you see the login form before you log in. A login you did not type yourself does not count: if you cannot sign out, stop and report AUTH_RESULT: failed | could not sign out first.',
    );
  }
  lines.push(
    'If the login cannot be finished in this browser, do what you would normally do in that case (including request_device when it applies) and say why.',
    '',
    'When you are done, make this the first line of the Summary, then call finish:',
    'AUTH_RESULT: ok | <what on the page shows you are signed in, e.g. the account name; never a secret>',
    'or',
    'AUTH_RESULT: failed | <why, in one line: what the page said or did>',
  );
  return lines.join('\n');
}

/** The task document for a case, as the web app would create it, plus the test's grants. */
export function taskDoc(
  c: Case,
  opts: {
    now: number;
    projectId: string;
    macDevice?: string;
    model?: string;
    budget: number;
    reuseSessions?: boolean;
  },
): Record<string, unknown> {
  const m = c.method;
  const allowRules = [
    ...(m.vault ? [`Vault(${m.vault})`] : []),
    ...(m.useGoogleSession ? ['GoogleSession(use)'] : []),
    // Login buttons ("Next", "Send", Enter in a password field) count as submits otherwise.
    ...m.hosts.map((h) => `Browser(submit:${h})`),
  ];
  return {
    title: `Auth test: ${m.label} on ${c.env}`,
    titleSource: 'user',
    description: taskDescription(c, opts),
    status: 'todo',
    priority: 'none',
    tags: ['auth-test'],
    projectId: opts.projectId,
    ai: {
      enabled: true,
      device: c.env === 'remote' ? 'gcp' : opts.macDevice,
      browser: 'chrome',
      budget: opts.budget,
      ...(modelFor(c.env, opts.model) ? { model: modelFor(c.env, opts.model) } : {}),
    },
    allowRules,
    allowedHosts: m.hosts,
    summary: '',
    externalRefs: {},
    createdAt: opts.now,
    updatedAt: opts.now,
  };
}

/**
 * The model a case runs on. The local model exists only on the Mac, and dodo moves a run that
 * uses it there even when the task is pinned to gcp, so a remote case always gets a cloud model
 * (`auto` is dodo's default Gemini) unless you name one. A local case uses yours (or your default).
 */
export function modelFor(env: Env, model?: string): string | undefined {
  const local = !!model && (model === 'local' || model.startsWith('local:'));
  if (env === 'remote') return model && !local ? model : 'auto';
  return model;
}

/** What a case left behind in Firestore, read once it has ended. */
export interface Observation {
  task: { status?: string; summary?: string; statusLine?: { text?: string }; activeRunId?: string };
  runs: Array<{
    device?: string;
    state?: string;
    endReason?: string;
    error?: string;
    spent?: number;
    createdAt?: number;
    startedAt?: number;
    endedAt?: number;
  }>;
  messages: Array<{
    author?: string;
    body?: string;
    createdAt?: number;
    input?: {
      kind?: string;
      prompt?: string;
      secret?: boolean;
      image?: unknown;
      moveToMac?: boolean;
      suggestedRule?: string;
      answer?: { value?: string };
    };
  }>;
  timedOut?: boolean;
}

/** What the tester said after the case. */
export interface TesterAnswers {
  /** Agrees with the agent's result (undefined: not asked or skipped). */
  confirmed?: boolean;
  /** Had to do something on the Mac itself: the Chrome window, Touch ID, a QR on its screen. */
  macInput?: boolean;
  notes?: string;
}

export type Verdict =
  | 'works'
  | 'works-with-mac-input'
  | 'works-after-move'
  | 'fails'
  | 'timeout'
  | 'error';

export interface CaseResult {
  id: string;
  method: string;
  label: string;
  env: Env;
  verdict: Verdict;
  /** The agent's own line, or why it failed. */
  detail: string;
  /** Where the runs went, in order: `remote`, `mac`. */
  devices: string[];
  questions: number;
  secretCodes: number;
  screenshots: number;
  /** Questions that sent you to the Mac's own screen. */
  macWindowAsks: number;
  /** A "continue on your Mac?" card was shown, and its answer. */
  moveAsked?: string;
  movedToMac: boolean;
  minutes: number;
  costEur: number;
  /** From the ledger after the case: model calls and Cloud Run time. */
  costModelEur?: number;
  costCloudEur?: number;
  tester: TesterAnswers;
  /** When the case ran, `YYYY-MM-DD HH:MM` (UTC). */
  date?: string;
}

/** The latest result of every case: newer ones replace older ones with the same id. */
export function mergeResults(before: CaseResult[], latest: CaseResult[]): CaseResult[] {
  const byId = new Map(before.map((r) => [r.id, r]));
  for (const r of latest) byId.set(r.id, r);
  return [...byId.values()];
}

/** A question that needs you at the Mac itself rather than on your phone. */
const MAC_WINDOW =
  /\b(chrome window|dodo chrome|on (?:your|the) (?:mac|screen|computer|laptop)|in the browser window)\b/i;

const isMac = (device?: string) => !!device?.startsWith('mac:');

/** Reads a finished case: the agent's claim, what happened on the way, and what you said. */
export function classify(c: Case, o: Observation, tester: TesterAnswers = {}): CaseResult {
  const devices = o.runs.map((r) => (isMac(r.device) ? 'mac' : 'remote'));
  const collapsed = devices.filter((d, i) => d !== devices[i - 1]);
  const inputs = o.messages.flatMap((m) => (m.input ? [m.input] : []));
  const asks = inputs.filter((i) => !i.moveToMac);
  const moveAsk = inputs.find((i) => i.moveToMac);
  const movedToMac = c.env === 'remote' && devices.includes('mac');
  const texts = [o.task.summary ?? '', ...o.messages.map((m) => m.body ?? '')];
  const line = texts.map((t) => RESULT_LINE.exec(t)).find(Boolean);
  const claimOk = line?.[1]?.toLowerCase() === 'ok';
  const errored = o.runs.find((r) => r.endReason === 'error');
  const starts = o.runs.map((r) => r.startedAt ?? r.createdAt ?? 0).filter(Boolean);
  const ends = o.runs.map((r) => r.endedAt ?? 0).filter(Boolean);
  const minutes =
    starts.length && ends.length
      ? Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 60_000)
      : 0;
  const spent = o.runs.reduce((sum, r) => sum + (r.spent ?? 0), 0);

  let verdict: Verdict;
  let detail = line?.[2]?.trim() ?? '';
  if (claimOk && tester.confirmed !== false) {
    verdict = movedToMac ? 'works-after-move' : tester.macInput ? 'works-with-mac-input' : 'works';
  } else if (o.timedOut && !line) {
    verdict = 'timeout';
    detail ||= o.task.statusLine?.text ?? 'no result before the time limit';
  } else if (errored && !line) {
    verdict = 'error';
    detail ||= errored.error ?? 'the run failed';
  } else {
    verdict = 'fails';
    if (claimOk && tester.confirmed === false)
      detail = `agent said ok, tester disagreed: ${detail}`;
    detail ||= o.task.statusLine?.text ?? 'no AUTH_RESULT line';
  }
  return {
    id: c.id,
    method: c.method.id,
    label: c.method.label,
    env: c.env,
    verdict,
    detail: oneLine(detail),
    devices: collapsed,
    questions: asks.length,
    secretCodes: asks.filter((i) => i.secret).length,
    screenshots: asks.filter((i) => i.image).length,
    macWindowAsks: asks.filter((i) => MAC_WINDOW.test(i.prompt ?? '')).length,
    moveAsked: moveAsk ? (moveAsk.answer?.value ?? 'unanswered') : undefined,
    movedToMac,
    minutes: Math.round(minutes * 10) / 10,
    costEur: Math.round(spent / 10_000) / 100,
    tester,
  };
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

const VERDICT_TEXT: Record<Verdict, string> = {
  works: 'works',
  'works-with-mac-input': 'works, needs you at the Mac',
  'works-after-move': 'works after moving to the Mac',
  fails: 'fails',
  timeout: 'no result (timed out)',
  error: 'run error',
};

/** The overview: a method × device table, then one line per case. Markdown. */
export function renderReport(results: CaseResult[], meta: { date: string; note?: string }): string {
  const methods = [...new Map(results.map((r) => [r.method, r.label])).entries()];
  const envs = ENVS.filter((e) => results.some((r) => r.env === e));
  const cell = (method: string, env: Env) => {
    const r = results.find((x) => x.method === method && x.env === env);
    if (!r) return '–';
    return r.verdict.startsWith('works')
      ? VERDICT_TEXT[r.verdict]
      : `${VERDICT_TEXT[r.verdict]}: ${r.detail.replace(/\|/g, '/')}`;
  };
  const head = `| Method | ${envs.map((e) => (e === 'local' ? 'Local (Mac)' : 'Remote (cloud)')).join(' | ')} |`;
  const rule = `|---|${envs.map(() => '---').join('|')}|`;
  const rows = methods.map(
    ([id, label]) => `| ${label} | ${envs.map((e) => cell(id, e)).join(' | ')} |`,
  );
  const details = results.map((r) => {
    const bits = [
      `runs on ${r.devices.join(' → ') || 'nothing'}`,
      `${r.questions} question${r.questions === 1 ? '' : 's'}`,
      r.secretCodes ? `${r.secretCodes} code${r.secretCodes === 1 ? '' : 's'}` : '',
      r.screenshots ? `${r.screenshots} screenshot${r.screenshots === 1 ? '' : 's'}` : '',
      r.macWindowAsks ? `${r.macWindowAsks}× asked to use the Mac's screen` : '',
      r.moveAsked ? `asked to move to the Mac: ${r.moveAsked}` : '',
      r.tester.macInput === true ? 'you acted on the Mac' : '',
      `${r.minutes} min`,
      r.costModelEur !== undefined
        ? `€${r.costEur.toFixed(2)} (model €${r.costModelEur.toFixed(2)}, cloud €${(r.costCloudEur ?? 0).toFixed(2)})`
        : `€${r.costEur.toFixed(2)}`,
      r.date ? `run ${r.date} UTC` : '',
    ].filter(Boolean);
    const notes = r.tester.notes ? ` Notes: ${oneLine(r.tester.notes)}` : '';
    return `- **${r.label}, ${r.env}**: ${VERDICT_TEXT[r.verdict]}${r.detail ? ` (${r.detail})` : ''}. ${bits.join(', ')}.${notes}`;
  });
  const total = results.reduce((s, r) => s + r.costEur, 0);
  return [
    `Updated ${meta.date} UTC: ${results.length} case${results.length === 1 ? '' : 's'}, €${total.toFixed(2)} in total.${meta.note ? ` ${meta.note}` : ''}`,
    '',
    head,
    rule,
    ...rows,
    '',
    ...details,
  ].join('\n');
}

export const MATRIX_START = '<!-- auth-matrix:start -->';
export const MATRIX_END = '<!-- auth-matrix:end -->';

/** Puts a fresh report between the markers of the overview document, keeping the rest. */
export function replaceMatrix(doc: string, report: string): string {
  const start = doc.indexOf(MATRIX_START);
  const end = doc.indexOf(MATRIX_END);
  const block = `${MATRIX_START}\n${report}\n${MATRIX_END}`;
  if (start === -1 || end === -1 || end < start) return `${doc.trimEnd()}\n\n${block}\n`;
  return doc.slice(0, start) + block + doc.slice(end + MATRIX_END.length);
}

/** Whether a case has ended, from the task and its pending questions. */
export function caseState(
  o: Pick<Observation, 'task' | 'messages'>,
): { ended: true } | { ended: false; waitingOn?: string } {
  const pending = o.messages.find((m) => m.input && !m.input.answer);
  if (o.task.activeRunId) return { ended: false, waitingOn: pending?.input?.prompt };
  if (o.task.status === 'review' || o.task.status === 'done' || o.task.status === 'cancelled') {
    return { ended: true };
  }
  if (o.task.status === 'needs_input' && pending) {
    return { ended: false, waitingOn: pending.input?.prompt };
  }
  if (o.task.status === 'needs_input') return { ended: true };
  return { ended: false };
}

// ── Cost ────────────────────────────────────────────────────────────────────

/**
 * Rough cost of one case before anything was measured: a login is some 10–20 model calls with
 * page snapshots, plus Cloud Run time for the remote browser (more while it waits for you).
 */
export const ROUGH_EUR: Record<Env, number> = { local: 0.1, remote: 0.15 };

export interface Estimate {
  cases: Array<{ id: string; eur: number; measured: boolean }>;
  total: number;
  /** The most it can cost: the budget cap of every case. */
  cap: number;
}

/** What a run of these cases should cost: the last measured cost of each case, else a rough guess. */
export function estimateCost(cases: Case[], history: CaseResult[], capEur: number): Estimate {
  const last = new Map(history.map((r) => [r.id, r]));
  const rows = cases.map((c) => {
    const seen = last.get(c.id);
    const eur = seen && seen.costEur > 0 ? seen.costEur : ROUGH_EUR[c.env];
    return { id: c.id, eur: Math.min(eur, capEur), measured: !!seen && seen.costEur > 0 };
  });
  const total = rows.reduce((s, r) => s + r.eur, 0);
  return { cases: rows, total: Math.round(total * 100) / 100, cap: capEur * cases.length };
}

/** Ledger entries of one task, summed: model calls, Cloud Run time, everything else. */
export function costBreakdown(entries: Array<{ category?: string; actual?: number }>): {
  model: number;
  cloud: number;
  other: number;
  total: number;
} {
  const eur = (micro: number) => Math.round(micro / 10_000) / 100;
  let model = 0;
  let cloud = 0;
  let other = 0;
  for (const e of entries) {
    const a = e.actual ?? 0;
    if (e.category === 'tokens') model += a;
    else if (e.category === 'infra') cloud += a;
    else other += a;
  }
  return {
    model: eur(model),
    cloud: eur(cloud),
    other: eur(other),
    total: eur(model + cloud + other),
  };
}

export const euro = (n: number) => `€${n.toFixed(2)}`;

// ── Vault: which entry each login uses ─────────────────────────────────────

export interface VaultSummary {
  id: string;
  name: string;
  domains: string[];
}

const covers = (domain: string, host: string) => {
  const d = domain.toLowerCase().replace(/^\*\./, '');
  return host === d || host.endsWith(`.${d}`);
};

/**
 * The vault entry a method logs in with: the one named in `vault`, else the first entry whose
 * domains cover one of `vaultHosts` (in that order), else of the method's hosts.
 */
export function resolveVault(m: Method, entries: VaultSummary[]): VaultSummary | undefined {
  if (m.vault) return entries.find((e) => e.id === m.vault);
  for (const host of m.vaultHosts?.length ? m.vaultHosts : m.hosts) {
    const hit = entries.find((e) => e.domains.some((d) => covers(d, host)));
    if (hit) return hit;
  }
  return undefined;
}
