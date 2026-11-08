import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCases,
  type Case,
  type CaseResult,
  caseState,
  classify,
  costBreakdown,
  defaultSite,
  estimateCost,
  guessEntry,
  MATRIX_END,
  MATRIX_START,
  mergeResults,
  methodFor,
  type Observation,
  parseTargets,
  renderReport,
  replaceMatrix,
  taskDescription,
  taskDoc,
} from './matrix.ts';

const example = parseTargets(
  JSON.parse(readFileSync(new URL('../targets.example.json', import.meta.url), 'utf8')),
);

describe('targets and cases', () => {
  it('reads the example targets and adds the site host to the hosts', () => {
    const google = example.methods.find((m) => m.id === 'google');
    expect(google?.hosts).toEqual(['myaccount.google.com', 'google.com']);
  });

  it('refuses a broken targets file with every problem at once', () => {
    expect(() =>
      parseTargets({ methods: [{ id: 'Bad Id', site: 'http://x.test' }, { id: 'ok' }] }),
    ).toThrow(/methods\[0\]\.id.*\n.*methods\[0\]\.site.*\n.*methods\[1\]\.site/s);
    expect(() => parseTargets({})).toThrow(/must be a list/);
  });

  it('crosses enabled methods with both devices, method by method', () => {
    expect(buildCases(example).map((c) => c.id)).toEqual([
      'itsme-local',
      'itsme-remote',
      'google-local',
      'google-remote',
      'password-local',
      'password-remote',
    ]);
  });

  it('runs a disabled method when named, and the stored Google session only remotely', () => {
    expect(buildCases(example, { only: ['google-session'] }).map((c) => c.id)).toEqual([
      'google-session-remote',
    ]);
    expect(buildCases(example, { only: ['itsme'], envs: ['remote'] }).map((c) => c.id)).toEqual([
      'itsme-remote',
    ]);
    expect(() => buildCases(example, { only: ['nope'] })).toThrow(/No method named nope/);
  });
});

const caseOf = (id: string): Case => {
  const c = buildCases(example).find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

describe('the test task', () => {
  it('pins the device, always has a browser, and grants only the login it tests', () => {
    const doc = taskDoc(caseOf('google-remote'), {
      now: 1,
      projectId: 'auth-tests',
      macDevice: 'mac:m1',
      budget: 400_000,
    });
    expect(doc.ai).toEqual({ enabled: true, device: 'gcp', browser: 'chrome', budget: 400_000 });
    expect(doc.allowRules).toEqual([
      'Vault(google)',
      'Browser(submit:myaccount.google.com)',
      'Browser(submit:google.com)',
    ]);
    expect(doc.allowedHosts).toEqual(['myaccount.google.com', 'google.com']);
    expect(doc.tags).toEqual(['auth-test']);
    const local = taskDoc(caseOf('itsme-local'), {
      now: 1,
      projectId: 'auth-tests',
      macDevice: 'mac:m1',
      budget: 400_000,
    });
    expect((local.ai as { device: string }).device).toBe('mac:m1');
  });

  it('tells the agent how to report, and how to treat existing sessions', () => {
    const remote = taskDescription(caseOf('google-remote'));
    expect(remote).toMatch(/AUTH_RESULT: ok \|/);
    expect(remote).toMatch(/do not call use_google_session/);
    expect(remote).toMatch(/sign out first/);
    expect(taskDescription(caseOf('google-local'))).not.toMatch(/use_google_session/);
    expect(taskDescription(caseOf('itsme-local'), { reuseSessions: true })).not.toMatch(
      /sign out first/,
    );
    const session = buildCases(example, { only: ['google-session'] })[0] as Case;
    expect(taskDescription(session)).toMatch(/Start by calling use_google_session/);
    expect(taskDoc(session, { now: 1, projectId: 'p', budget: 1 }).allowRules).toContain(
      'GoogleSession(use)',
    );
  });
});

const obs = (patch: Partial<Observation> = {}): Observation => ({
  task: { status: 'review', summary: 'AUTH_RESULT: ok | Signed in as Arnout\n\nDone.' },
  runs: [
    { device: 'gcp', endReason: 'finished', spent: 123_456, startedAt: 1_000, endedAt: 91_000 },
  ],
  messages: [],
  ...patch,
});

describe('classify', () => {
  it('reads the agent line, cost and duration', () => {
    const r = classify(caseOf('google-remote'), obs(), { confirmed: true });
    expect(r).toMatchObject({
      verdict: 'works',
      detail: 'Signed in as Arnout',
      devices: ['remote'],
      minutes: 1.5,
      costEur: 0.12,
      movedToMac: false,
    });
  });

  it('counts questions, codes, screenshots and asks to use the Mac screen', () => {
    const r = classify(
      caseOf('itsme-local'),
      obs({
        runs: [{ device: 'mac:m1', endReason: 'finished' }],
        messages: [
          { author: 'agent', input: { kind: 'text', prompt: 'Approve in itsme', image: {} } },
          { author: 'agent', input: { kind: 'text', prompt: 'The code?', secret: true } },
          {
            author: 'agent',
            input: { kind: 'text', prompt: 'Please log in in the dodo Chrome window on your Mac' },
          },
        ],
      }),
      { confirmed: true, macInput: true },
    );
    expect(r).toMatchObject({
      verdict: 'works-with-mac-input',
      questions: 3,
      secretCodes: 1,
      screenshots: 1,
      macWindowAsks: 1,
    });
  });

  it('a remote case that finished on the Mac worked after the move', () => {
    const r = classify(
      caseOf('google-remote'),
      obs({
        runs: [
          { device: 'gcp', endReason: 'needs_device' },
          { device: 'mac:m1', endReason: 'finished' },
        ],
        messages: [
          {
            author: 'system',
            input: {
              kind: 'approval',
              prompt: 'Continue on your Mac?',
              moveToMac: true,
              answer: { value: 'yes' },
            },
          },
        ],
      }),
    );
    expect(r).toMatchObject({
      verdict: 'works-after-move',
      devices: ['remote', 'mac'],
      moveAsked: 'yes',
      questions: 0,
    });
  });

  it('failures: the agent says so, you disagree, time runs out, or the run errors', () => {
    const failed = obs({
      task: {
        status: 'needs_input',
        summary: 'AUTH_RESULT: failed | Google: this browser may not be secure',
      },
    });
    expect(classify(caseOf('google-remote'), failed)).toMatchObject({
      verdict: 'fails',
      detail: 'Google: this browser may not be secure',
    });
    expect(classify(caseOf('google-remote'), obs(), { confirmed: false }).verdict).toBe('fails');
    expect(
      classify(
        caseOf('google-remote'),
        obs({ task: { status: 'needs_input', statusLine: { text: 'Waiting' } }, timedOut: true }),
      ),
    ).toMatchObject({ verdict: 'timeout', detail: 'Waiting' });
    expect(
      classify(
        caseOf('google-remote'),
        obs({ task: { status: 'needs_input' }, runs: [{ endReason: 'error', error: 'boom' }] }),
      ),
    ).toMatchObject({ verdict: 'error', detail: 'boom' });
  });
});

describe('caseState', () => {
  it('waits while a run is going or a question is open; ends otherwise', () => {
    const q = { author: 'agent', input: { kind: 'text', prompt: 'Code?' } };
    expect(caseState({ task: { activeRunId: 'r' }, messages: [] }).ended).toBe(false);
    expect(caseState({ task: { status: 'todo' }, messages: [] }).ended).toBe(false);
    expect(caseState({ task: { status: 'needs_input' }, messages: [q] })).toEqual({
      ended: false,
      waitingOn: 'Code?',
    });
    expect(
      caseState({
        task: { status: 'needs_input' },
        messages: [{ ...q, input: { ...q.input, answer: { value: 'x' } } }],
      }).ended,
    ).toBe(true);
    expect(caseState({ task: { status: 'review' }, messages: [] }).ended).toBe(true);
  });
});

describe('the overview', () => {
  const results: CaseResult[] = buildCases(example, { only: ['itsme', 'google'] }).map((c, i) =>
    classify(
      c,
      i === 3
        ? obs({
            task: { status: 'needs_input', summary: 'AUTH_RESULT: failed | refused | browser' },
          })
        : obs(),
      { confirmed: true },
    ),
  );

  it('renders a method × device table and a line per case', () => {
    const md = renderReport(results, { date: '2026-11-08 12:00' });
    expect(md).toContain('| Method | Local (Mac) | Remote (cloud) |');
    expect(md).toContain('| itsme | works | works |');
    // A pipe in the agent's reason must not break the table.
    expect(md).toContain('| Google | works | fails: refused / browser |');
    expect(md).toMatch(/- \*\*Google, remote\*\*: fails/);
  });

  it('keeps the latest result per case and replaces only the marked block', () => {
    const newer = { ...(results[0] as CaseResult), detail: 'newer' };
    const merged = mergeResults(results, [newer]);
    expect(merged).toHaveLength(results.length);
    expect(merged[0]?.detail).toBe('newer');
    const doc = `# Title\n\nIntro\n\n${MATRIX_START}\nold\n${MATRIX_END}\n\nAfter\n`;
    expect(replaceMatrix(doc, 'new')).toBe(
      `# Title\n\nIntro\n\n${MATRIX_START}\nnew\n${MATRIX_END}\n\nAfter\n`,
    );
    expect(replaceMatrix('# T\n', 'x')).toBe(`# T\n\n${MATRIX_START}\nx\n${MATRIX_END}\n`);
  });
});

describe('cost', () => {
  it('expects the last measured cost per case, else a rough guess, never above the cap', () => {
    const cases = buildCases(example, { only: ['itsme'] });
    const seen = classify(cases[1] as Case, obs({ runs: [{ device: 'gcp', spent: 230_000 }] }));
    const est = estimateCost(cases, [seen], 0.4);
    expect(est.cases).toEqual([
      { id: 'itsme-local', eur: 0.1, measured: false },
      { id: 'itsme-remote', eur: 0.23, measured: true },
    ]);
    expect(est.total).toBe(0.33);
    expect(est.cap).toBe(0.8);
    expect(estimateCost(cases, [{ ...seen, costEur: 2 }], 0.4).cases[1]?.eur).toBe(0.4);
  });

  it('splits the ledger into model calls and Cloud Run time', () => {
    expect(
      costBreakdown([
        { category: 'tokens', actual: 51_000 },
        { category: 'tokens', actual: 20_000 },
        { category: 'infra', actual: 9_000 },
        { category: 'action', actual: 5_000 },
      ]),
    ).toEqual({ model: 0.07, cloud: 0.01, other: 0.01, total: 0.09 });
  });
});

describe('setup', () => {
  const entries = [
    { id: 'shop', name: 'Webshop', domains: ['shop.test'] },
    {
      id: 'energy',
      name: 'Energy',
      domains: ['engie.be', 'itsme-id.com'],
      hint: 'Log in with itsme',
    },
    { id: 'google', name: 'Google account', domains: ['google.com'] },
  ];

  it('guesses the entry for each login kind', () => {
    expect(guessEntry('itsme', entries)?.id).toBe('energy');
    expect(guessEntry('google', entries)?.id).toBe('google');
    expect(guessEntry('password', entries)?.id).toBe('shop');
  });

  it('builds a valid method from the entry and the start page', () => {
    const energy = entries[1] as (typeof entries)[number];
    expect(defaultSite('itsme', energy)).toBe('https://engie.be/');
    expect(defaultSite('google', entries[2] as (typeof entries)[number])).toBe(
      'https://myaccount.google.com/',
    );
    const m = methodFor('itsme', energy, 'https://www.engie.be/login');
    expect(m).toMatchObject({ id: 'itsme', vault: 'energy', hosts: ['engie.be', 'itsme-id.com'] });
    expect(parseTargets({ methods: [m] }).methods[0]?.hosts).toEqual([
      'www.engie.be',
      'engie.be',
      'itsme-id.com',
    ]);
  });
});
