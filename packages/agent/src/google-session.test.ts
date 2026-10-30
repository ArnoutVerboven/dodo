import { describe, expect, it } from 'vitest';
import type { TaskStore } from './control-plane.js';
import { googleSessionTool } from './google-session.js';

const ctx = { store: {} as TaskStore };

describe('use_google_session', () => {
  it('loads the saved session once and says what to do next', async () => {
    let loads = 0;
    const tool = googleSessionTool({
      load: async () => {
        loads++;
        return true;
      },
    });
    const out = await tool.execute({ reason: 'booking.com' }, ctx);
    expect(out.result).toMatchObject({ ok: true, note: expect.stringContaining('is loaded') });
    await tool.execute({ reason: 'booking.com' }, ctx);
    expect(loads).toBe(1);
  });

  it('explains the one-time sign-in when nothing is saved, and reports failures', async () => {
    const none = await googleSessionTool({ load: async () => false }).execute({ reason: 'x' }, ctx);
    expect(none.result).toMatchObject({ note: expect.stringContaining('No Google session') });
    const broken = await googleSessionTool({
      load: async () => {
        throw new Error('offline');
      },
    }).execute({ reason: 'x' }, ctx);
    expect(broken.result).toEqual({ error: 'Google session not available: offline' });
  });
});
