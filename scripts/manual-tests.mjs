// Runs a manually triggered suite from tests/manual/suites.mjs.
//
//   pnpm test:manual              list the suites
//   pnpm test:manual <name>       run one (asks before anything that costs money)
//   pnpm test:manual <name> --yes skip the question (the CI workflow passes it)
//
// Each run's output also goes to tests/manual/reports/<name>-<time>.log (not committed).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { suites } from '../tests/manual/suites.mjs';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const name = args.find((a) => !a.startsWith('--'));
const inCi = !!process.env.CI;

function list() {
  console.log('Manual test suites (pnpm test:manual <name>):\n');
  for (const s of suites) {
    console.log(`  ${s.name.padEnd(10)} ${s.description}`);
    console.log(
      `  ${''.padEnd(10)} where: ${s.where.join(', ')} · cost: ${s.cost.join(', ')}${s.interactive ? ' · needs you during the run' : ''}`,
    );
    console.log(`  ${''.padEnd(10)} when: ${s.when}\n`);
  }
}

if (!name) {
  list();
  process.exit(0);
}
const suite = suites.find((s) => s.name === name);
if (!suite) {
  console.error(`No manual suite "${name}".\n`);
  list();
  process.exit(2);
}
if (inCi && !suite.where.includes('ci')) {
  console.error(`"${name}" runs locally only (${suite.description}). Run it on your Mac.`);
  process.exit(2);
}
if (inCi && suite.interactive) {
  console.error(`"${name}" needs someone during the run; it cannot run in CI.`);
  process.exit(2);
}
const missing = (suite.env ?? []).filter((v) => !process.env[v]);
if (missing.length) {
  console.error(`"${name}" needs ${missing.join(', ')} set.`);
  process.exit(2);
}

const costly = suite.cost.some((c) => c !== 'free');
if (costly && !yes) {
  if (!process.stdin.isTTY) {
    console.error(`"${name}" costs ${suite.cost.join(' + ')}: pass --yes to run it unattended.`);
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `"${name}" costs ${suite.cost.join(' + ')}${suite.interactive ? ' and needs you (phone, browser) during the run' : ''}. Run it? [y/N] `,
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) process.exit(1);
}

mkdirSync('tests/manual/reports', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = `tests/manual/reports/${name}-${stamp}.log`;
const log = createWriteStream(logPath);
console.log(`> ${suite.command}   (log: ${logPath})`);
// Interactive suites keep the terminal (prompts, QR codes); the others are teed to the log.
const child = spawn(suite.command, {
  shell: true,
  stdio: suite.interactive ? 'inherit' : ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, DODO_MANUAL_SUITE: name, DODO_MANUAL_REPORT_DIR: 'tests/manual/reports' },
});
for (const stream of [child.stdout, child.stderr]) {
  stream?.on('data', (chunk) => {
    (stream === child.stderr ? process.stderr : process.stdout).write(chunk);
    log.write(chunk);
  });
}
child.on('exit', (code, signal) => {
  const summary = `\n${name}: ${code === 0 ? 'passed' : `failed (${signal ?? `exit ${code}`})`}\n`;
  log.end(summary);
  console.log(summary);
  process.exit(code ?? 1);
});
