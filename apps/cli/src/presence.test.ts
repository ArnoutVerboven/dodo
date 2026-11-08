import { describe, expect, it } from 'vitest';
import { onBeat } from './presence.js';

const I = 30_000;

describe('onBeat', () => {
  it('stays quiet while heartbeats are confirmed', () => {
    expect(onBeat({ confirmedAt: 0, beatAt: 0 }, I, I).stalled).toBe(false);
  });

  it('calls the connection dead after four beats without a confirmation', () => {
    let w = { confirmedAt: 0, beatAt: 0 };
    const stalls: boolean[] = [];
    for (let t = I; t <= 5 * I; t += I) {
      const r = onBeat(w, t, I);
      w = r.watch;
      stalls.push(r.stalled);
    }
    expect(stalls).toEqual([false, false, false, false, true]);
  });

  it('gives a fresh window after the Mac slept', () => {
    const r = onBeat({ confirmedAt: 0, beatAt: 0 }, 3 * 3600_000, I);
    expect(r.stalled).toBe(false);
    expect(r.watch.confirmedAt).toBe(3 * 3600_000);
    let w = r.watch;
    let stalled = false;
    for (let k = 1; k <= 5; k++) ({ watch: w, stalled } = onBeat(w, 3 * 3600_000 + k * I, I));
    expect(stalled).toBe(true);
  });
});
