import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** browser-use runs its own loop in Python; this starts it for one task and reads its result. */

export const BROWSER_USE_VERSION = '0.13.14';

export interface FrameworkResult {
  calls: number;
  input: number;
  output: number;
  cached: number;
  seconds: number;
  url: string;
  text: string;
  agentSaysDone: boolean;
  error: string | null;
}

export function runBrowserUse(cfg: {
  start: string;
  goal: string;
  url: string;
  model: string;
  apiKey?: string;
  headed: boolean;
  executablePath?: string;
  noSandbox?: boolean;
  maxSteps: number;
  /** The server honours response_format with a JSON schema (OpenAI, Gemini). */
  structuredOutput?: boolean;
}): Promise<FrameworkResult> {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser_use_run.py');
  return new Promise((resolve) => {
    const child = spawn(
      'uv',
      ['run', '--quiet', '--with', `browser-use==${BROWSER_USE_VERSION}`, 'python', script],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_LOGGING_LEVEL: 'result' },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    const fail = (why: string): FrameworkResult => ({
      calls: 0,
      input: 0,
      output: 0,
      cached: 0,
      seconds: 0,
      url: '',
      text: '',
      agentSaysDone: false,
      error: why,
    });
    child.on('error', (e) =>
      resolve(fail(`could not start uv (install it: https://docs.astral.sh/uv/): ${e.message}`)),
    );
    child.on('close', () => {
      const line = out
        .trim()
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('{'));
      if (!line) return resolve(fail(`no result; stderr: ${err.slice(-800)}`));
      try {
        resolve(JSON.parse(line) as FrameworkResult);
      } catch {
        resolve(fail(`bad result: ${line.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(cfg));
  });
}
