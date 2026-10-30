import { describe, expect, it } from 'vitest';
import { repoDir, repoList, reposFor } from './github.js';
import { eur, InputRequest } from './model.js';
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

describe('repos', () => {
  it('read the older single repo as a list, clean and dedupe', () => {
    expect(repoList({ repo: 'me/app' })).toEqual(['me/app']);
    expect(
      repoList({ repos: ['https://github.com/me/app.git', 'Me/App', 'not a repo', 'me/web'] }),
    ).toEqual(['me/app', 'me/web']);
    expect(repoList({ repo: 'me/old', repos: ['me/new'] })).toEqual(['me/new']);
  });

  it('take the task repos over the project ones, as a whole', () => {
    const project = { defaults: { repos: ['me/a', 'me/b'] } };
    expect(reposFor({ ai: {} }, project)).toEqual(['me/a', 'me/b']);
    expect(reposFor({ ai: { repos: ['me/c'] } }, project)).toEqual(['me/c']);
    const r = resolveAiConfig({ ai: { enabled: true } }, project, settings);
    expect(r.repos).toEqual(['me/a', 'me/b']);
  });

  it('check one repo out in the task folder, several in subfolders', () => {
    expect(repoDir('me/app', ['me/app'])).toBe('.');
    expect(repoDir('me/app', ['me/app', 'me/web'])).toBe('app');
    expect(repoDir('me/app', ['me/app', 'you/app'])).toBe('me-app');
  });
});

describe('InputRequest', () => {
  it('keeps the top-up of a budget ask, so answering it in the app does not drop it', () => {
    const parsed = InputRequest.parse({ kind: 'approval', prompt: 'Top up?', topUp: 500_000 });
    expect(parsed.topUp).toBe(500_000);
  });
});
