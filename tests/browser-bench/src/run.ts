import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentBrowserDriver } from './drivers/agent-browser.ts';
import { runBrowserUse } from './drivers/browser-use.ts';
import { type McpVariant, mcpDriver } from './drivers/mcp.ts';
import type { Driver, DriverOptions } from './drivers/types.ts';
import { startFixture } from './fixture.ts';
import { runLoop } from './loop.ts';
import { type Model, openAiModel, scriptedModel } from './model.ts';
import { replay } from './replay.ts';
import { type Approach, type RunRecord, summarize } from './report.ts';
import { loadTasks, passed, type Task } from './tasks.ts';

const HELP = `Browser bench: the same navigation tasks, once per approach, with one model.

  pnpm --filter @dodo/browser-bench bench [options]

Model (OpenAI-compatible chat completions with tool calls):
  (default)               your dodo local model from ~/.dodo/config.json, started if needed
  --model-url <url>       e.g. http://localhost:8080/v1
  --model <name>
  --gemini                Gemini through its OpenAI endpoint; key from GEMINI_API_KEY,
                          model gemini-3.8-flash unless --model is given
  --vertex <project>      Gemini on Vertex AI with your gcloud login (no API key needed);
                          --region defaults to global; --model as for --gemini
  --api-key <key>         or BENCH_API_KEY

What to run:
  --approaches <list>     comma-separated; default all:
                          dodo-current,mcp-inline,mcp-inline-pruned,mcp-interactive,mcp-find,
                          agent-browser,browser-use,replay
  --tasks <list>          task ids, or "live" (default) or "fixture"
  --tasks-file <file>     your own tasks (JSON array: id, start, goal, url?, text?)
  --reps <n>              runs per task and approach (default 1)
  --max-calls <n>         model calls per run before giving up (default 25)

Browser:
  --headed                show the browser window
  --cloud                 the browser dodo's GCP worker uses: Playwright's headless Chromium with
                          its anti-detection flag and user agent (your home IP, not Google's)
  --interactive           ask_user asks you in this terminal (do it in the window, then answer)
  --executable-path <p>   Chrome/Chromium binary (default: each tool's own; Chrome on a Mac)
  --no-sandbox            for Linux containers running as root

  --self-test             offline check: local test shop, scripted model, no API calls
  --out <dir>             results folder (default tests/browser-bench/results)
`;

const ALL: Approach[] = [
  'dodo-current',
  'mcp-inline',
  'mcp-inline-pruned',
  'mcp-interactive',
  'mcp-find',
  'agent-browser',
  'browser-use',
  'replay',
];
const MCP = new Set<Approach>([
  'dodo-current',
  'mcp-inline',
  'mcp-inline-pruned',
  'mcp-interactive',
  'mcp-find',
]);

const SCRIPTS: Record<string, Parameters<typeof scriptedModel>[0]> = {
  'shop-email-login': [
    { click: 'Close' },
    { click: 'Choose essential only' },
    { click: 'Sign up | Log in' },
    { click: 'Log in' },
    { click: 'email' },
  ],
  'shop-google-login': [
    { click: 'Close' },
    { click: 'Choose essential only' },
    { click: 'Sign up | Log in' },
    { click: 'Log in' },
    { click: 'Continue with Google' },
  ],
  'shop-search': [
    { click: 'Close' },
    { click: 'Choose essential only' },
    { search: 'Nike Air Max 90' },
    { click: 'Nike Air Max 90 size 38 €5.00' },
  ],
};

async function main() {
  const { values: v } = parseArgs({
    options: {
      'model-url': { type: 'string' },
      model: { type: 'string' },
      gemini: { type: 'boolean', default: false },
      'api-key': { type: 'string' },
      vertex: { type: 'string' },
      region: { type: 'string', default: 'global' },
      approaches: { type: 'string' },
      tasks: { type: 'string' },
      'tasks-file': { type: 'string' },
      reps: { type: 'string', default: '1' },
      'max-calls': { type: 'string', default: '25' },
      headed: { type: 'boolean', default: false },
      cloud: { type: 'boolean', default: false },
      interactive: { type: 'boolean', default: false },
      'executable-path': { type: 'string' },
      'no-sandbox': { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    console.log(HELP);
    return;
  }
  const selfTest = v['self-test'];
  const approaches = (v.approaches ? v.approaches.split(',') : ALL)
    .map((a) => a.trim())
    .filter((a): a is Approach => {
      if ((ALL as string[]).includes(a)) return true;
      throw new Error(`unknown approach ${a}; one of ${ALL.join(', ')}`);
    })
    .filter((a) => !(selfTest && a === 'browser-use'));
  // Replay needs a recording from an earlier approach in the same bench run.
  approaches.sort((a, b) => Number(a === 'replay') - Number(b === 'replay'));

  const all = loadTasks(v['tasks-file']);
  const sel = v.tasks ?? (selfTest ? 'fixture' : v['tasks-file'] ? undefined : 'live');
  const tasks = all.filter((t) =>
    !sel
      ? true
      : sel === 'live' || sel === 'fixture'
        ? t.where === sel
        : sel.split(',').includes(t.id),
  );
  if (!tasks.length) throw new Error('no tasks selected');

  const fixture = tasks.some((t) => t.where === 'fixture') ? await startFixture() : undefined;
  const resolveStart = (t: Task) => t.start.replace('{fixture}', fixture?.url ?? '');

  let stopModel: (() => void) | undefined;
  let modelCtl: { url: string; restart?: () => Promise<void> } | undefined;
  let model: Model | undefined;
  let modelCfg: { url: string; model: string; apiKey?: string } | undefined;
  if (!selfTest) {
    const m = await pickModel(v);
    modelCfg = m.cfg;
    stopModel = m.stop;
    modelCtl = { url: m.cfg.url, restart: m.restart };
    const cfg = m.cfg;
    model = openAiModel({ ...cfg, apiKey: () => cfg.apiKey, timeoutMs: 900_000 });
  }

  const reps = Math.max(1, Number(v.reps) || 1);
  const maxCalls = Math.max(1, Number(v['max-calls']) || 25);
  const outDir = path.resolve(
    v.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results'),
  );
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const records: RunRecord[] = [];
  const recordings = new Map<string, string[]>();
  const save = () => {
    const meta = {
      when: new Date().toISOString(),
      model: selfTest ? 'scripted' : modelCfg?.model,
      modelUrl: selfTest ? undefined : modelCfg?.url.replace(/key=[^&]+/, 'key=…'),
      host: `${os.platform()} ${os.arch()}`,
      reps,
      maxCalls,
    };
    writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ meta, records }, null, 2));
    writeFileSync(path.join(outDir, `${stamp}.md`), summarize(meta, records));
  };

  let cloud: DriverOptions['cloud'];
  let cloudExecutable: string | undefined;
  if (v.cloud) {
    const { chromium } = await import('playwright');
    const b = await chromium
      .launch({ headless: true, chromiumSandbox: !v['no-sandbox'] })
      .catch((e: Error) => {
        throw new Error(
          `--cloud needs Playwright's Chromium: run \`pnpm --filter @dodo/browser-bench exec playwright install chromium chromium-headless-shell\` (${e.message.split('\n')[0]})`,
        );
      });
    // The same user agent the worker sets (apps/worker/src/headless.ts chromeUserAgent).
    const major = b.version().split('.')[0] || '131';
    cloud = {
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    };
    await b.close();
    cloudExecutable = chromium.executablePath();
  }
  const driverOpts = (workdir: string): DriverOptions => ({
    headed: v.headed && !v.cloud,
    cloud,
    // agent-browser and browser-use bring their own Chrome; in cloud mode they use Playwright's.
    executablePath: v['executable-path'] ?? cloudExecutable,
    noSandbox: v['no-sandbox'],
    workdir,
  });

  const runOnce = async (task: Task, approach: Approach, rep: number): Promise<RunRecord> => {
    const start = resolveStart(task);
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'dodo-bench-'));
    const t0 = Date.now();
    let rec: RunRecord;
    try {
      if (approach === 'browser-use') {
        const r = await runBrowserUse({
          start,
          goal: task.goal,
          url: modelCfg?.url ?? '',
          model: modelCfg?.model ?? '',
          apiKey: modelCfg?.apiKey,
          headed: v.headed && !v.cloud,
          executablePath: v['executable-path'] ?? cloudExecutable,
          noSandbox: v['no-sandbox'],
          maxSteps: maxCalls,
          userAgent: cloud?.userAgent,
          structuredOutput: /googleapis\.com|openai\.com/.test(modelCfg?.url ?? ''),
        });
        rec = base(task, approach, rep, {
          success: !r.error?.startsWith('could not start') && passed(task, r),
          agentSaysDone: r.agentSaysDone,
          calls: r.calls,
          input: r.input,
          output: r.output,
          cached: r.cached,
          maxInput: 0,
          seconds: r.seconds,
          finalUrl: r.url,
          error: r.error ?? undefined,
        });
      } else if (approach === 'replay') {
        const code = recordings.get(task.id);
        if (!code) {
          rec = base(task, approach, rep, {
            success: false,
            error: 'no recording: run an mcp-* approach on this task first, successfully',
            skipped: true,
          });
        } else {
          const r = await replay(start, code, driverOpts(workdir));
          rec = base(task, approach, rep, {
            success: passed(task, r),
            agentSaysDone: true,
            seconds: (Date.now() - t0) / 1000,
            finalUrl: r.url,
            error: r.error,
          });
        }
      } else {
        const driver: Driver = MCP.has(approach)
          ? await mcpDriver(approach as McpVariant, driverOpts(workdir))
          : await agentBrowserDriver(driverOpts(workdir));
        try {
          const m = model ?? scriptedModel(SCRIPTS[task.id] ?? []);
          const r = await runLoop({
            model: m,
            driver,
            goal: task.goal,
            start,
            maxCalls,
            interactive: v.interactive,
          });
          const final = await driver.finalState();
          const ok = passed(task, final);
          if (ok && MCP.has(approach) && !recordings.has(task.id) && driver.recorded)
            recordings.set(task.id, driver.recorded());
          rec = base(task, approach, rep, {
            success: ok,
            agentSaysDone: r.agentSaysDone,
            calls: r.calls.length,
            input: sum(r.calls.map((c) => c.input)),
            output: sum(r.calls.map((c) => c.output)),
            cached: sum(r.calls.map((c) => c.cached)),
            maxInput: Math.max(0, ...r.calls.map((c) => c.input)),
            seconds: (Date.now() - t0) / 1000,
            asked: r.asked,
            observedChars: r.observedChars,
            toolSchemaChars: r.toolSchemaChars,
            estimated: r.calls.some((c) => c.estimated),
            finalUrl: final.url,
            error: r.error,
            perCall: r.calls.map((c) => ({
              input: c.input,
              output: c.output,
              tools: c.tools,
            })),
          });
        } finally {
          await driver.close();
        }
      }
    } catch (e) {
      rec = base(task, approach, rep, { success: false, error: (e as Error).message });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    return rec;
  };

  console.log(
    `${tasks.length} task(s) × ${approaches.length} approach(es) × ${reps} rep(s), model ${selfTest ? 'scripted' : modelCfg?.model}\n`,
  );
  try {
    for (const task of tasks) {
      for (const approach of approaches) {
        for (let rep = 1; rep <= reps; rep++) {
          let rec = await runOnce(task, approach, rep);
          const down =
            MODEL_DOWN.test(rec.error ?? '') ||
            (approach === 'browser-use' && rec.input === 0 && !(await healthy(modelCfg)));
          if (modelCtl && down) {
            if (!modelCtl.restart)
              throw new Error(
                `The model at ${modelCtl.url} stopped answering, and the bench did not start it, so it cannot restart it. Restart it and rerun.`,
              );
            console.log('  the local model crashed; restarting it and running this one again');
            await modelCtl.restart();
            rec = await runOnce(task, approach, rep);
            if (MODEL_DOWN.test(rec.error ?? ''))
              throw new Error(
                'The local model keeps crashing; stopping. Try fewer approaches or --max-calls 15.',
              );
          }
          records.push(rec);
          console.log(
            `${rec.success ? '✓' : '✗'} ${task.id.padEnd(22)} ${approach.padEnd(18)} calls ${String(rec.calls).padStart(2)}  in ${String(rec.input).padStart(7)}  out ${String(rec.output).padStart(5)}  ${rec.seconds.toFixed(0).padStart(4)}s${rec.success || !rec.finalUrl ? '' : `  ended on ${shortUrl(rec.finalUrl)}`}${rec.error ? `  ${rec.error.slice(0, 120)}` : ''}`,
          );
          save();
        }
      }
    }
  } finally {
    await fixture?.close();
    stopModel?.();
  }
  console.log(`\n${summarize({ model: selfTest ? 'scripted' : modelCfg?.model }, records)}`);
  console.log(`Saved to ${path.join(outDir, stamp)}.{json,md}`);
}

/** The model server went away (mlx_lm.server can die on a long prompt). */
const MODEL_DOWN =
  /model 404|model 5\d\d|fetch failed|ECONNREFUSED|ECONNRESET|generation thread died/;

const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 70);
  } catch {
    return u.slice(0, 70);
  }
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function base(task: Task, approach: Approach, rep: number, r: Partial<RunRecord>): RunRecord {
  return {
    task: task.id,
    approach,
    rep,
    success: false,
    agentSaysDone: false,
    calls: 0,
    input: 0,
    output: 0,
    cached: 0,
    maxInput: 0,
    seconds: 0,
    asked: 0,
    observedChars: 0,
    toolSchemaChars: 0,
    estimated: false,
    finalUrl: '',
    ...r,
  };
}

async function pickModel(v: {
  'model-url'?: string;
  model?: string;
  gemini: boolean;
  'api-key'?: string;
  vertex?: string;
  region?: string;
}): Promise<{
  cfg: { url: string; model: string; apiKey?: string };
  stop?: () => void;
  restart?: () => Promise<void>;
}> {
  const apiKey = v['api-key'] ?? process.env.BENCH_API_KEY;
  if (v.vertex) {
    // Vertex AI's OpenAI-compatible endpoint, with your gcloud login; tokens last an hour, so
    // refresh every 45 minutes for long runs.
    const token = () =>
      execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
    const region = v.region ?? 'global';
    const host =
      region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
    const cfg = {
      url: `https://${host}/v1/projects/${v.vertex}/locations/${region}/endpoints/openapi`,
      model: `google/${(v.model ?? 'gemini-3.8-flash').replace(/^google\//, '')}`,
      apiKey: token(),
    };
    setInterval(() => {
      cfg.apiKey = token();
    }, 45 * 60_000).unref();
    return { cfg };
  }
  if (v.gemini) {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error('--gemini needs GEMINI_API_KEY (or --api-key)');
    return {
      cfg: {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: v.model ?? 'gemini-3.8-flash',
        apiKey: key,
      },
    };
  }
  if (v['model-url']) return { cfg: { url: v['model-url'], model: v.model ?? 'default', apiKey } };
  const file = path.join(process.env.DODO_HOME ?? path.join(os.homedir(), '.dodo'), 'config.json');
  const local = existsSync(file)
    ? (
        JSON.parse(readFileSync(file, 'utf8')) as {
          localModel?: { url: string; model?: string; command?: string[] };
        }
      ).localModel
    : undefined;
  if (!local)
    throw new Error('No model: pass --model-url, --gemini, or set one up with `dodo model set`.');
  const cfg = { url: local.url, model: v.model ?? local.model ?? 'default', apiKey };
  const command = local.command;
  let child: ChildProcess | undefined;
  const startServer = async () => {
    if (!command?.length) throw new Error(`The local model at ${cfg.url} is not running.`);
    child?.kill('SIGTERM');
    console.log(`Starting the local model: ${command.join(' ')}`);
    child = spawn(command[0] ?? '', command.slice(1), { stdio: 'ignore' });
    for (let i = 0; i < 180; i++) {
      if (await reachable(cfg.url)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    child.kill('SIGTERM');
    throw new Error(`The local model did not come up at ${cfg.url} within 3 minutes.`);
  };
  // A server someone else started (the dodo daemon) is not ours to restart.
  if (await reachable(cfg.url)) return { cfg };
  await startServer();
  const restart = async () => {
    // mlx_lm.server stays up after its generation thread dies, holding the port: kill it and
    // wait for the port to free before starting a fresh one.
    child?.kill('SIGKILL');
    for (let i = 0; i < 15 && (await reachable(cfg.url)); i++)
      await new Promise((r) => setTimeout(r, 1000));
    await startServer();
  };
  return { cfg, restart, stop: () => child?.kill('SIGTERM') };
}

/** The server answers a one-token completion: up and able to generate. */
async function healthy(cfg?: { url: string; model: string; apiKey?: string }): Promise<boolean> {
  if (!cfg) return true;
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
