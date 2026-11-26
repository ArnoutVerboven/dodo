import { HOLDING_LOG } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { RunSupervisor } from './supervisor.js';
import { FakeControlPlane } from './testing.js';

const ask = { kind: 'text' as const, prompt: 'Code?', session: [], holdMs: 60_000 };

describe('RunSupervisor.holdForAnswer', () => {
  it('beats at once when the answer arrives instead of waiting for the next beat', async () => {
    const control = new FakeControlPlane([]);
    let fire: (() => void) | undefined;
    let unwatched = false;
    const logs: string[] = [];
    const supervisor = new RunSupervisor(control, {
      heartbeatMs: 15_000,
      watchAnswer: (id, onChange) => {
        expect(id).toBe('m1');
        fire = onChange;
        return () => {
          unwatched = true;
        };
      },
      log: (m) => logs.push(m),
    });
    const started = Date.now();
    const held = supervisor.holdForAnswer(ask, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    control.heldAnswers.push({ messageId: 'm1', prompt: 'Code?', value: '42' });
    fire?.();
    const answer = await held;
    expect(answer?.value).toBe('42');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(unwatched).toBe(true);
    expect(logs).toContain(HOLDING_LOG);
  });

  it('keeps beating briefly when the answer lags behind the change', async () => {
    const control = new FakeControlPlane([]);
    let fire: (() => void) | undefined;
    const supervisor = new RunSupervisor(control, {
      heartbeatMs: 15_000,
      watchAnswer: (_id, onChange) => {
        fire = onChange;
        return () => {};
      },
    });
    const held = supervisor.holdForAnswer(ask, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    fire?.(); // the change shows before the heartbeat can hand the answer over
    setTimeout(
      () => control.heldAnswers.push({ messageId: 'm1', prompt: 'Code?', value: 'late' }),
      300,
    );
    expect((await held)?.value).toBe('late');
  });

  it('ends the hold when released, and when a comment comes in instead of an answer', async () => {
    const control = new FakeControlPlane([]);
    const release = new AbortController();
    const supervisor = new RunSupervisor(control, {
      heartbeatMs: 15_000,
      holdRelease: release.signal,
    });
    const held = supervisor.holdForAnswer(ask, 60_000);
    setTimeout(() => release.abort(), 20);
    expect(await held).toBeUndefined();

    const control2 = new FakeControlPlane([]);
    control2.flags = { pendingMessages: [{ id: 'c1', body: 'use staging', createdAt: 1 }] };
    const supervisor2 = new RunSupervisor(control2, { heartbeatMs: 10 });
    expect(await supervisor2.holdForAnswer(ask, 60_000)).toBeUndefined();
    expect(supervisor2.stopReason()).toBeUndefined();
  });
});
