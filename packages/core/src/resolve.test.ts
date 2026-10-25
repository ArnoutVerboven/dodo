import { describe, expect, it } from 'vitest';
import { eur } from './model.js';
import { resolveAiConfig } from './resolve.js';

const settings = {
  defaults: { model: 'gemini-flash', device: 'gcp' as const },
  defaultTaskBudget: eur(0.5),
};

describe('resolveAiConfig', () => {
  it('uses global defaults when nothing else is set', () => {
    const r = resolveAiConfig({ ai: { enabled: true } }, undefined, settings);
    expect(r).toMatchObject({ model: 'gemini-flash', device: 'gcp', budget: eur(0.5) });
  });

  it('lets project override global and task override project', () => {
    const r = resolveAiConfig(
      { ai: { enabled: true, budget: eur(2) } },
      { defaults: { device: 'mac:air', model: 'gemini-pro', folder: '~/code/x' } },
      settings,
    );
    expect(r).toMatchObject({
      model: 'gemini-pro',
      device: 'mac:air',
      budget: eur(2),
      folder: '~/code/x',
    });
  });

  it('falls back to auto when no layer sets model or device', () => {
    const r = resolveAiConfig({ ai: { enabled: true } }, undefined, {
      defaults: {},
      defaultTaskBudget: 1,
    });
    expect(r.model).toBe('auto');
    expect(r.device).toBe('auto');
  });
});
