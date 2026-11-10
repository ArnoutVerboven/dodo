import type { Task } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt.js';

const task = {} as Task;

describe('logging in', () => {
  it('on the Mac: the vault entry first, then Google, then email, and it solves codes itself', () => {
    const p = systemPrompt(task, undefined, { browser: 'window' });
    const order = ['vault entry', "'Continue with Google'", "site's own email option"].map((t) =>
      p.indexOf(t),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain('get_email_code');
    expect(p).toMatch(/Hand the page to the user only for .*CAPTCHA.*itsme.*passkey/);
  });

  it('in the cloud: only the vault entry, and everything else moves to the Mac', () => {
    const p = systemPrompt(task, undefined, { browser: 'headless', canRequestDevice: true });
    expect(p).toContain('only one way in works here');
    expect(p).toMatch(/any Google sign-in page/);
    expect(p).toContain('call request_device as soon as');
    expect(p).not.toContain('use_google_session');
    const stuck = systemPrompt(task, undefined, { browser: 'headless' });
    expect(stuck).toContain('finish as blocked');
    expect(stuck).not.toContain('call request_device as soon as');
  });
});
