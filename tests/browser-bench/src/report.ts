/** Results: one record per run, and the side-by-side summary written next to them. */

export type Approach =
  | 'dodo-current'
  | 'mcp-inline'
  | 'mcp-inline-pruned'
  | 'mcp-interactive'
  | 'mcp-find'
  | 'agent-browser'
  | 'browser-use'
  | 'replay';

export interface RunRecord {
  task: string;
  approach: Approach;
  rep: number;
  /** The bench's own check of the final page. */
  success: boolean;
  agentSaysDone: boolean;
  calls: number;
  input: number;
  output: number;
  cached: number;
  /** Largest single prompt: how big the context got. */
  maxInput: number;
  seconds: number;
  asked: number;
  observedChars: number;
  toolSchemaChars: number;
  estimated: boolean;
  finalUrl: string;
  error?: string;
  skipped?: boolean;
  perCall?: Array<{ input: number; output: number; tools: string[] }>;
}

/** gemini-3.8-flash list price (packages/budget/src/pricing.ts), 1 USD = 1 EUR as there. */
const IN_PER_M = 0.75;
const OUT_PER_M = 3.75;
export const euro = (r: Pick<RunRecord, 'input' | 'output'>) =>
  (r.input * IN_PER_M + r.output * OUT_PER_M) / 1_000_000;

/** Own prices of models worth benchmarking (USD per 1M tokens, from packages/budget). */
const OWN: Record<string, [number, number]> = {
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.5-flash': [1.5, 9],
  'gemini-3.5-flash-lite': [0.3, 2.5],
  'gemini-3.1-flash-lite': [0.25, 1.5],
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n: number, d = 0) =>
  n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

export function summarize(meta: Record<string, unknown>, records: RunRecord[]): string {
  const ran = records.filter((r) => !r.skipped);
  const approaches = [...new Set(ran.map((r) => r.approach))];
  const tasks = [...new Set(ran.map((r) => r.task))];
  const lines: string[] = [];
  lines.push(`# Browser bench, ${meta.model ?? ''}`);
  lines.push('');
  lines.push(
    'Cost is at gemini-3.8-flash list prices ($0.75/M in, $3.75/M out) for the tokens this model reported, so approaches compare on the same scale.',
  );
  lines.push('');
  lines.push(
    '| Approach | Success | Model calls (avg) | Input tokens (avg) | Output tokens (avg) | Largest prompt | € per run | € per success | Seconds (avg) |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const a of approaches) {
    const rs = ran.filter((r) => r.approach === a);
    const ok = rs.filter((r) => r.success).length;
    const cost = rs.reduce((s, r) => s + euro(r), 0);
    lines.push(
      `| ${a} | ${ok}/${rs.length} | ${fmt(mean(rs.map((r) => r.calls)), 1)} | ${fmt(mean(rs.map((r) => r.input)))} | ${fmt(mean(rs.map((r) => r.output)))} | ${fmt(mean(rs.map((r) => r.maxInput)))} | ${fmt(cost / rs.length, 4)} | ${ok ? fmt(cost / ok, 4) : '–'} | ${fmt(mean(rs.map((r) => r.seconds)), 0)} |`,
    );
  }
  const own = OWN[String(meta.model ?? '').replace(/^google\//, '')];
  if (own) {
    const total = ran.reduce((t, r) => t + (r.input * own[0] + r.output * own[1]) / 1_000_000, 0);
    lines.push(
      '',
      `At ${meta.model}'s own price, this whole bench run cost about €${fmt(total, 2)}.`,
    );
  }
  lines.push('');
  lines.push('Per task: success, model calls, input tokens (averaged over reps).');
  lines.push('');
  lines.push(`| Task | ${approaches.join(' | ')} |`);
  lines.push(`| --- | ${approaches.map(() => '---').join(' | ')} |`);
  for (const t of tasks) {
    const cells = approaches.map((a) => {
      const rs = ran.filter((r) => r.task === t && r.approach === a);
      if (!rs.length) return '';
      const ok = rs.filter((r) => r.success).length;
      return `${ok}/${rs.length} · ${fmt(mean(rs.map((r) => r.calls)), 1)} · ${fmt(mean(rs.map((r) => r.input)) / 1000, 1)}k`;
    });
    lines.push(`| ${t} | ${cells.join(' | ')} |`);
  }
  const errors = ran.filter((r) => r.error);
  if (errors.length) {
    lines.push('');
    lines.push('Errors:');
    for (const r of errors)
      lines.push(`- ${r.task} / ${r.approach} #${r.rep}: ${r.error?.slice(0, 200)}`);
  }
  if (ran.some((r) => r.estimated))
    lines.push(
      '',
      'Some token counts were estimated from characters because the server reported no usage.',
    );
  return `${lines.join('\n')}\n`;
}
