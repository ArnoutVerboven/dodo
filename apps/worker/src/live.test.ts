import type { LiveAction, LiveFrame } from '@dodo/browser-engine';
import type { LiveView } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { LiveRelay, type LiveSource, type LiveStore } from './live.js';

function fakeStore() {
  const cbs: {
    held?: (h: boolean) => void;
    want?: (w: boolean) => void;
    input?: (items: Array<{ id: string; data: unknown }>, initial: boolean) => void;
  } = {};
  const views: Array<{ view: LiveView; jpeg?: Uint8Array }> = [];
  const deleted: string[] = [];
  let inputSubs = 0;
  const store: LiveStore = {
    onHeld: (cb) => {
      cbs.held = cb;
      return () => (cbs.held = undefined);
    },
    onWant: (cb) => {
      cbs.want = cb;
      return () => (cbs.want = undefined);
    },
    onInput: (cb) => {
      cbs.input = cb;
      inputSubs++;
      return () => (cbs.input = undefined);
    },
    putView: async (view, jpeg) => {
      views.push({ view, jpeg });
    },
    deleteInput: async (id) => {
      deleted.push(id);
    },
  };
  return { store, cbs, views, deleted, inputSubs: () => inputSubs };
}

function fakeSource(fail?: string) {
  let onFrame: ((f: LiveFrame) => void) | undefined;
  const actions: LiveAction[] = [];
  let starts = 0;
  let stops = 0;
  const source: LiveSource = {
    start: async (cb) => {
      if (fail) throw new Error(fail);
      starts++;
      onFrame = cb;
    },
    input: async (a) => {
      actions.push(a);
    },
    stop: async () => {
      stops++;
      onFrame = undefined;
    },
  };
  const frame = (seq: number) =>
    onFrame?.({
      jpeg: Buffer.from([0xff, 0xd8, seq]),
      width: 800,
      height: 600,
      seq,
      url: 'https://x.test/',
    });
  return { source, actions, frame, starts: () => starts, stops: () => stops };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveRelay', () => {
  it('starts only while the run holds for an answer and the owner has the view open', async () => {
    const s = fakeStore();
    const src = fakeSource();
    const relay = new LiveRelay(s.store, src.source);
    relay.listen();
    expect(s.views).toEqual([
      {
        view: { active: false, width: 0, height: 0, seq: 0, at: expect.any(Number) },
        jpeg: undefined,
      },
    ]);
    s.cbs.want?.(true);
    await relay.idle();
    expect(src.starts()).toBe(0);
    s.cbs.held?.(true);
    await relay.idle();
    expect(src.starts()).toBe(1);
    s.cbs.want?.(false);
    await relay.idle();
    expect(src.stops()).toBe(1);
    expect(s.views.at(-1)?.view.active).toBe(false);
    await relay.close();
  });

  it('turns off and says so when the answer comes', async () => {
    const s = fakeStore();
    const src = fakeSource();
    const relay = new LiveRelay(s.store, src.source);
    relay.listen();
    s.cbs.held?.(true);
    s.cbs.want?.(true);
    await relay.idle();
    s.cbs.held?.(false);
    await relay.idle();
    expect(src.stops()).toBe(1);
    expect(s.views.at(-1)?.view).toMatchObject({
      active: false,
      note: 'The agent has the page again.',
    });
  });

  it('sends frames no faster than the limit and never drops the newest', async () => {
    let now = 1_000_000;
    const s = fakeStore();
    const src = fakeSource();
    const relay = new LiveRelay(s.store, src.source, { now: () => now });
    relay.listen();
    s.cbs.held?.(true);
    s.cbs.want?.(true);
    await relay.idle();
    src.frame(1);
    await tick();
    src.frame(2);
    src.frame(3);
    await tick();
    const sent = () => s.views.filter((v) => v.view.active).map((v) => v.view.seq);
    expect(sent()).toEqual([1]);
    now += 600;
    await new Promise((r) => setTimeout(r, 600));
    expect(sent()).toEqual([1, 3]);
    expect([...(s.views.at(-1)?.jpeg ?? [])]).toEqual([0xff, 0xd8, 3]);
    await relay.close();
  });

  it('replays new input in order, drops what was there before, and deletes both', async () => {
    const s = fakeStore();
    const src = fakeSource();
    const relay = new LiveRelay(s.store, src.source);
    relay.listen();
    s.cbs.held?.(true);
    s.cbs.want?.(true);
    await relay.idle();
    s.cbs.input?.([{ id: 'old', data: { type: 'click', x: 1, y: 1, at: 1 } }], true);
    s.cbs.input?.(
      [
        { id: 'a', data: { type: 'click', x: 10, y: 20, at: 2 } },
        { id: 'b', data: { type: 'text', text: '1234', at: 3 } },
        { id: 'c', data: { type: 'key', key: 'rm -rf', at: 4 } },
        { id: 'd', data: { type: 'key', key: 'Enter', at: 5 } },
      ],
      false,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(src.actions).toEqual([
      { type: 'click', x: 10, y: 20 },
      { type: 'text', text: '1234' },
      { type: 'key', key: 'Enter' },
    ]);
    expect(s.deleted).toEqual(['old', 'a', 'b', 'c', 'd']);
    await relay.close();
  });

  it('tells the owner when the page cannot be shown', async () => {
    const s = fakeStore();
    const src = fakeSource('no page is open');
    const relay = new LiveRelay(s.store, src.source);
    relay.listen();
    s.cbs.held?.(true);
    s.cbs.want?.(true);
    await relay.idle();
    expect(s.views.at(-1)?.view).toMatchObject({
      active: false,
      note: 'The page could not be shown: no page is open',
    });
    expect(s.inputSubs()).toBe(0);
  });

  it('stops at the end of the run', async () => {
    const s = fakeStore();
    const src = fakeSource();
    const relay = new LiveRelay(s.store, src.source);
    relay.listen();
    s.cbs.held?.(true);
    s.cbs.want?.(true);
    await relay.idle();
    await relay.close();
    expect(src.stops()).toBe(1);
    expect(s.cbs.held).toBeUndefined();
    expect(s.views.at(-1)?.view.active).toBe(false);
  });
});
