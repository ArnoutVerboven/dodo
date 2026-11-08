import { type ChildProcess, spawn } from 'node:child_process';
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
      approaches: { type: 'string' },
      tasks: { type: 'string' },
      'tasks-file': { type: 'string' },
      reps: { type: 'string', default: '1' },
      'max-calls': { type: 'string', default: '25' },
      headed: { type: 'boolean', default: false },
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
  let model: Model | undefined;
  let modelCfg: { url: string; model: string; apiKey?: string } | undefined;
  if (!selfTest) {
    const m = await pickModel(v);
    modelCfg = m.cfg;
    stopModel = m.stop;
    model = openAiModel({ ...m.cfg, timeoutMs: 900_000 });
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

  const driverOpts = (workdir: string): DriverOptions => ({
    headed: v.headed,
    executablePath: v['executable-path'],
    noSandbox: v['no-sandbox'],
    workdir,
  });

  console.log(
    `${tasks.length} task(s) × ${approaches.length} approach(es) × ${reps} rep(s), model ${selfTest ? 'scripted' : modelCfg?.model}\n`,
  );
  try {
    for (const task of tasks) {
      for (const approach of approaches) {
        for (let rep = 1; rep <= reps; rep++) {
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
                headed: v.headed,
                executablePath: v['executable-path'],
                noSandbox: v['no-sandbox'],
                maxSteps: maxCalls,
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
          records.push(rec);
          console.log(
            `${rec.success ? '✓' : '✗'} ${task.id.padEnd(22)} ${approach.padEnd(18)} calls ${String(rec.calls).padStart(2)}  in ${String(rec.input).padStart(7)}  out ${String(rec.output).padStart(5)}  ${rec.seconds.toFixed(0).padStart(4)}s${rec.error ? `  ${rec.error.slice(0, 100)}` : ''}`,
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
}): Promise<{ cfg: { url: string; model: string; apiKey?: string }; stop?: () => void }> {
  const apiKey = v['api-key'] ?? process.env.BENCH_API_KEY;
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
  if (await reachable(cfg.url)) return { cfg };
  if (!local.command?.length) throw new Error(`The local model at ${cfg.url} is not running.`);
  console.log(`Starting the local model: ${local.command.join(' ')}`);
  const child: ChildProcess = spawn(local.command[0] ?? '', local.command.slice(1), {
    stdio: 'ignore',
  });
  for (let i = 0; i < 180; i++) {
    if (await reachable(cfg.url)) return { cfg, stop: () => child.kill('SIGTERM') };
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill('SIGTERM');
  throw new Error(`The local model did not come up at ${cfg.url} within 3 minutes.`);
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
