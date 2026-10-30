import type { Device } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { looksLikeBrowserWork, routeDevice, routeLocalModel, routeToMac } from './routing.js';
import { decideBrowser } from './triggers.js';

const now = 1_000_000;
const mac = (id: string, name: string, lastSeen: number, state: Device['state'] = 'approved') =>
  ({
    id,
    name,
    platform: 'darwin',
    state,
    lastSeen,
    folders: [],
    createdAt: 0,
    updatedAt: 0,
  }) as Device;

describe('routeDevice', () => {
  it('keeps an explicit choice', () => {
    expect(routeDevice('gcp', undefined, [mac('d1', 'Air', now)], now).device).toBe('gcp');
    expect(routeDevice('mac:d1', undefined, [], now)).toEqual({
      device: 'mac:d1',
      reason: 'mac:d1',
    });
  });

  it('auto: the Mac seen most recently when one is online', () => {
    const devices = [mac('d1', 'Air', now - 20_000), mac('d2', 'Studio', now - 5_000)];
    expect(routeDevice('auto', undefined, devices, now)).toEqual({
      device: 'mac:d2',
      reason: 'Studio is online',
    });
  });

  it('auto: remote when no Mac is online and nothing needs one', () => {
    const devices = [mac('d1', 'Air', now - 600_000), mac('d2', 'Old', now, 'revoked')];
    expect(routeDevice('auto', undefined, devices, now).device).toBe('gcp');
    expect(routeDevice('auto', undefined, [], now).device).toBe('gcp');
  });

  it('auto: a task with a folder waits for the Mac that has it', () => {
    const devices = [mac('d1', 'Air', now - 600_000)];
    expect(routeDevice('auto', '~/code/x', devices, now)).toEqual({
      device: 'mac:d1',
      reason: 'folder ~/code/x is on Air',
    });
    // No Mac paired at all: remote, in a scratch folder.
    expect(routeDevice('auto', '~/code/x', [], now).device).toBe('gcp');
  });
});

describe('decideBrowser', () => {
  const yes = async () => true;
  const no = async () => false;

  it('follows an explicit setting', async () => {
    expect((await decideBrowser('chrome', { trigger: 'new' }, no)).browser).toBe(true);
    expect((await decideBrowser('none', { trigger: 'new', browser: true }, yes)).browser).toBe(
      false,
    );
    expect((await decideBrowser(undefined, { trigger: 'new' }, yes)).browser).toBe(false);
  });

  it('auto: asks the router once for a new task', async () => {
    let asked = 0;
    const ask = async () => {
      asked++;
      return true;
    };
    expect(await decideBrowser('auto', { trigger: 'new' }, ask)).toEqual({
      browser: true,
      reason: 'the task needs a browser',
    });
    expect(asked).toBe(1);
  });

  it('auto: a continued conversation keeps its browser, a step-up gets one', async () => {
    expect((await decideBrowser('auto', { trigger: 'comment', browser: true }, no)).browser).toBe(
      true,
    );
    expect((await decideBrowser('auto', { trigger: 'resume', browser: false }, yes)).browser).toBe(
      false,
    );
    expect((await decideBrowser('auto', { trigger: 'resume', browser: true }, no)).browser).toBe(
      true,
    );
    expect((await decideBrowser('auto', { trigger: 'comment' }, yes)).browser).toBe(false);
  });

  it('auto: a reply about a website gets a browser on a task that ran without one', async () => {
    const reply = (hint: string) =>
      decideBrowser('auto', { trigger: 'comment', browser: false, hint }, no);
    expect(await reply('Can you log in to booking.com and check my reservation?')).toEqual({
      browser: true,
      reason: 'the reply is about a website',
    });
    expect((await reply('Thanks, shorter please')).browser).toBe(false);
    expect(
      (await decideBrowser('none', { trigger: 'comment', browser: false, hint: 'log in' }, yes))
        .browser,
    ).toBe(false);
  });

  it('knows website work from the words alone (local-model tasks)', () => {
    expect(looksLikeBrowserWork('Log in to Booking.com and list my bookings')).toBe(true);
    expect(looksLikeBrowserWork('Bestel een taart bij de bakker')).toBe(true);
    expect(looksLikeBrowserWork('check https://example.org/status')).toBe(true);
    expect(looksLikeBrowserWork('Summarise this PDF in three bullets')).toBe(false);
    expect(looksLikeBrowserWork('Write a haiku about autumn')).toBe(false);
  });

  it('auto: no browser when the router fails or is absent', async () => {
    const boom = async () => {
      throw new Error('quota');
    };
    expect((await decideBrowser('auto', { trigger: 'new' }, boom)).browser).toBe(false);
    expect((await decideBrowser('auto', { trigger: 'new' }, undefined)).browser).toBe(false);
  });
});

describe('routeToMac', () => {
  it('picks the approved Mac seen most recently, online or not', () => {
    const devices = [
      mac('d1', 'Air', now - 3_600_000),
      mac('d2', 'Studio', now - 7_200_000),
      mac('d3', 'Old', now, 'pending'),
    ];
    expect(routeToMac(devices)).toEqual({ device: 'mac:d1', reason: 'moved to Air by the agent' });
  });

  it('is undefined without a paired Mac', () => {
    expect(routeToMac([mac('d3', 'Old', now, 'pending')])).toBeUndefined();
  });
});

describe('routeLocalModel', () => {
  const devices = [mac('d1', 'Air', now - 3_600_000), mac('d2', 'Studio', now - 7_200_000)];
  it('sends auto and remote to the Mac seen most recently', () => {
    expect(routeLocalModel('auto', devices)).toEqual({
      device: 'mac:d1',
      reason: 'Air, local model',
    });
    expect(routeLocalModel('gcp', devices)?.device).toBe('mac:d1');
  });

  it('keeps the Mac the task names', () => {
    expect(routeLocalModel('mac:d2', devices)).toEqual({
      device: 'mac:d2',
      reason: 'Studio, local model',
    });
  });

  it('is undefined without a paired Mac', () => {
    expect(routeLocalModel('auto', [])).toBeUndefined();
  });
});
