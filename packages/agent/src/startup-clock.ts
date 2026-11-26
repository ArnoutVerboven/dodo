/**
 * Where the time goes between "run queued" and the agent's first step. Every mark is wall-clock
 * epoch ms, so marks from the control plane (queued, dispatched), the Mac daemon (claimed,
 * worker spawned) and the worker itself line up on one axis; the clocks are NTP-synced, which
 * is plenty for phases that last hundreds of milliseconds or more.
 *
 * The first model reply carries the summary in its trace event (`data.startup`) and the worker
 * logs it as one line, so a slow start can be read off any run's trace or log.
 */

/** Marks in the order a run normally passes them; anything else sorts by time after these. */
export const STARTUP_PHASES = [
  'queued', // run doc created (control plane)
  'dispatch_started', // dispatcher took it (remote)
  'execution_requested', // Cloud Run Jobs runJob returned (remote)
  'claimed', // Mac daemon's deviceClaim returned
  'daemon_browser_ready', // Mac: browser server up
  'daemon_mcp_ready', // Mac: local MCP endpoints handed out
  'daemon_model_route', // Mac: local model route decided
  'worker_spawned', // Mac: worker process spawned (inside the sandbox)
  'process_start', // worker node process started
  'worker_loaded', // worker bundle evaluated
  'signed_in', // run identity signed in
  'run_started', // runStart callable returned (session loaded)
  'workdir_ready',
  'repos_ready',
  'browser_ready',
  'mcp_ready',
  'tools_ready',
  'harness_ready', // harness set up, opening turn built
  'first_model_request',
  'first_model_reply',
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export interface StartupSummary {
  /** Epoch ms per mark. */
  marks: Record<string, number>;
  /** Time from the previous mark to this one, in the order the marks happened. */
  phases: Array<{ phase: string; ms: number }>;
  /** First mark to last. */
  totalMs: number;
}

export class StartupClock {
  private readonly marks = new Map<string, number>();
  private reported = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a phase as reached now; the first time counts. */
  mark(phase: StartupPhase | string): void {
    if (!this.marks.has(phase)) this.marks.set(phase, this.now());
  }

  /** Records marks taken elsewhere (control plane, daemon); bad values are ignored. */
  add(marks: Record<string, unknown> | undefined): void {
    for (const [phase, at] of Object.entries(marks ?? {})) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0 && !this.marks.has(phase))
        this.marks.set(phase, Math.round(at));
    }
  }

  has(phase: string): boolean {
    return this.marks.has(phase);
  }

  summary(): StartupSummary {
    const order = (p: string) => {
      const i = (STARTUP_PHASES as readonly string[]).indexOf(p);
      return i < 0 ? STARTUP_PHASES.length : i;
    };
    const sorted = [...this.marks.entries()].sort(
      (a, b) => a[1] - b[1] || order(a[0]) - order(b[0]),
    );
    const phases = sorted.slice(1).map(([phase, at], i) => ({
      phase,
      ms: at - (sorted[i]?.[1] ?? at),
    }));
    const first = sorted[0]?.[1] ?? 0;
    const last = sorted.at(-1)?.[1] ?? 0;
    return { marks: Object.fromEntries(sorted), phases, totalMs: last - first };
  }

  /** One log line: `startup 25.1s: queued → dispatch_started 0.2s · …`. */
  line(): string {
    const s = this.summary();
    const first = Object.keys(s.marks)[0] ?? '';
    const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
    return `startup ${fmt(s.totalMs)} from ${first}: ${s.phases.map((p) => `${p.phase} +${fmt(p.ms)}`).join(' · ')}`;
  }

  /** The summary once per run (the first model reply), undefined after that. */
  takeReport(): StartupSummary | undefined {
    if (this.reported) return undefined;
    this.reported = true;
    return this.summary();
  }
}
