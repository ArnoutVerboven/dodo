import { type HeartbeatResponse, HOLDING_LOG, type RunEndReason } from '@dodo/core';
import { type ControlPlane, LeaseLostError, type RunInput } from './control-plane.js';

/** The lease is 60 s (functions/src/runtime.ts): stop trusting failed beats well before it. */
export const DEFAULT_HEARTBEAT_TOLERANCE_MS = 40_000;

export interface SupervisorOptions {
  /** Heartbeat timer interval in ms; 0 disables the timer (beats still happen on demand). */
  heartbeatMs?: number;
  /** How long beats may keep failing before the run gives up; a lost lease ends it at once. */
  heartbeatToleranceMs?: number;
  /**
   * Calls `onChange` whenever the question's message changes (its answer arrives), so a hold
   * beats at once instead of at the next timer beat. Returns the unsubscribe. Absent: the
   * hold only finds the answer on its regular beats.
   */
  watchAnswer?: (messageId: string, onChange: () => void) => () => void;
  /** Aborted: a hold in progress ends now and the run parks (the Mac has other work queued). */
  holdRelease?: AbortSignal;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** After the answer's message changed: beat this often until the heartbeat hands it over. */
const ANSWER_RECHECK_MS = 250;
const ANSWER_RECHECKS = 8;

/** An answer the heartbeat delivered while the run held a question open. */
export type HeldAnswer = NonNullable<RunInput['answer']> & { messageId: string };

/**
 * Everything between a run and the control plane's heartbeat: lease renewal, the stop flags
 * (halt, interrupt, budget, lost lease), steering comments, manual compaction and answers to a
 * held question. A harness never calls the heartbeat itself; it asks the supervisor.
 */
export class RunSupervisor {
  private flags: HeartbeatResponse | undefined;
  private error: Error | undefined;
  // The server hands a compaction request over once, possibly to a timer beat: keep it.
  private compactAsked = false;
  /** An answer the heartbeat delivered during a hold; kept until the hold takes it. */
  private heldAnswer: HeartbeatResponse['answer'];
  // One beat at a time: the timer and the run share the call in flight, so the server never
  // sees two overlapping heartbeats for one run.
  private inFlight: Promise<void> | undefined;
  private lastBeatOk = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Set<string>();
  private readonly tolerance: number;
  private readonly log: NonNullable<SupervisorOptions['log']>;

  constructor(
    private readonly control: ControlPlane,
    private readonly opts: SupervisorOptions = {},
  ) {
    this.tolerance = opts.heartbeatToleranceMs ?? DEFAULT_HEARTBEAT_TOLERANCE_MS;
    this.log = opts.log ?? (() => {});
  }

  /** Beats on a timer too, so a long tool call cannot let the lease expire. */
  start(): void {
    if (this.opts.heartbeatMs && !this.timer) {
      this.timer = setInterval(() => void this.beat(), this.opts.heartbeatMs);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  beat(): Promise<void> {
    this.inFlight ??= this.beatOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async beatOnce(): Promise<void> {
    try {
      this.flags = await this.control.heartbeat();
      this.lastBeatOk = Date.now();
      if (this.flags.compact) this.compactAsked = true;
      if (this.flags.answer) this.heldAnswer = this.flags.answer;
    } catch (err) {
      // A failed beat is only fatal once the lease is at risk: one network blip or cold start
      // must not end the run. A lost lease is fatal at once.
      if (err instanceof LeaseLostError || Date.now() - this.lastBeatOk >= this.tolerance) {
        this.error = err as Error;
      } else {
        this.log('heartbeat failed; trying again', { err: String(err) });
      }
    }
  }

  /** Why the run must stop now, from the last beat; undefined while it may go on. */
  stopReason(): { reason: RunEndReason; error?: string } | undefined {
    if (this.error) {
      return {
        reason: this.error instanceof LeaseLostError ? 'lease_lost' : 'error',
        error: this.error.message,
      };
    }
    if (this.flags && !this.flags.ok) {
      const r = this.flags.reason;
      return {
        reason:
          r === 'halted' || r === 'interrupted' || r === 'budget_exhausted' ? r : 'lease_lost',
      };
    }
    return undefined;
  }

  /** Comments posted during the run that the agent has not seen yet (steering). */
  takeSteering(): Array<{ id: string; body: string }> {
    const fresh = (this.flags?.pendingMessages ?? []).filter((m) => !this.seen.has(m.id));
    for (const m of fresh) this.seen.add(m.id);
    return fresh;
  }

  /** Whether the user pressed Compact since the last call; asking clears it. */
  takeCompactRequest(): boolean {
    const asked = this.compactAsked;
    this.compactAsked = false;
    return asked;
  }

  /**
   * ask_user with a hold: post the question, then beat until the answer comes, the hold runs
   * out, or the run is told to stop (read stopReason after).
   */
  async holdForAnswer(
    req: Parameters<ControlPlane['requestInput']>[0],
    holdMs: number,
  ): Promise<HeldAnswer | undefined> {
    const posted = await this.control.requestInput(req);
    const messageId = posted && 'messageId' in posted ? posted.messageId : undefined;
    // The Mac daemon reads this line: it brings the browser window forward and knows the run
    // can be released for other work.
    this.log(HOLDING_LOG, { messageId, holdMs });
    const until = Date.now() + holdMs;
    const every = this.opts.heartbeatMs || 1000;
    const release = this.opts.holdRelease;
    // The answer's message changed: beat now, and keep beating briefly until it is handed over.
    let changed = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      changed = true;
      wake?.();
    };
    let unwatch: (() => void) | undefined;
    if (messageId && this.opts.watchAnswer) {
      try {
        unwatch = this.opts.watchAnswer(messageId, notify);
      } catch (err) {
        this.log('answer watch failed; beats only', { err: String(err) });
      }
    }
    release?.addEventListener('abort', notify);
    let rechecks = 0;
    try {
      while (Date.now() < until) {
        if (release?.aborted) return undefined;
        const wait = changed ? ANSWER_RECHECK_MS : Math.min(every, Math.max(0, until - Date.now()));
        if (changed && ++rechecks > ANSWER_RECHECKS) {
          // Changed but no answer (an edit, or the snapshot's own first delivery): back to beats.
          changed = false;
          rechecks = 0;
          continue;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = undefined;
        if (release?.aborted) return undefined;
        await this.beat();
        if (this.stopReason()) return undefined;
        const a = this.heldAnswer;
        if (a && (!messageId || a.messageId === messageId)) {
          this.heldAnswer = undefined;
          return a;
        }
        // A reply in the thread instead of on the card: park now; the control plane starts
        // the next run with that comment, as it did before runs held.
        if ((this.flags?.pendingMessages ?? []).some((m) => !this.seen.has(m.id))) {
          this.log('a comment came in while holding; parking the run for it');
          return undefined;
        }
      }
      return undefined;
    } finally {
      release?.removeEventListener('abort', notify);
      unwatch?.();
    }
  }
}
