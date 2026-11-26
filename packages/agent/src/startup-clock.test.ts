import { describe, expect, it } from 'vitest';
import { StartupClock } from './startup-clock.js';

describe('StartupClock', () => {
  it('orders marks from every source on one axis and reports once', () => {
    let t = 1_000;
    const clock = new StartupClock(() => t);
    clock.add({ queued: 100, execution_requested: 400, dispatch_started: 300, bogus: 'x' });
    clock.add({ process_start: 900.6 });
    clock.mark('signed_in');
    t = 1_500;
    clock.mark('first_model_request');
    clock.mark('first_model_request'); // the first time counts
    t = 3_500;
    clock.mark('first_model_reply');

    const s = clock.takeReport();
    expect(s?.totalMs).toBe(3_400);
    expect(s?.phases).toEqual([
      { phase: 'dispatch_started', ms: 200 },
      { phase: 'execution_requested', ms: 100 },
      { phase: 'process_start', ms: 501 },
      { phase: 'signed_in', ms: 99 },
      { phase: 'first_model_request', ms: 500 },
      { phase: 'first_model_reply', ms: 2_000 },
    ]);
    expect(Object.keys(s?.marks ?? {})).not.toContain('bogus');
    expect(clock.takeReport()).toBeUndefined();
    expect(clock.line()).toMatch(/^startup 3\.4s from queued: dispatch_started \+200ms · /);
  });

  it('keeps marks the worker already took over later ones from elsewhere', () => {
    const clock = new StartupClock(() => 50);
    clock.mark('claimed');
    clock.add({ claimed: 10 });
    expect(clock.summary().marks.claimed).toBe(50);
  });
});
