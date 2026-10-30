import { repoList } from './github.js';
import type { AiConfig, GlobalSettings, Project, Task } from './model.js';

export type ResolvedAiConfig = Required<Pick<AiConfig, 'model' | 'device' | 'budget'>> &
  Omit<AiConfig, 'model' | 'device' | 'budget'>;

/**
 * Merge AI settings: task values win over project defaults, which win over global defaults.
 * Unset model and device resolve to `auto`.
 */
export function resolveAiConfig(
  task: Pick<Task, 'ai'>,
  project: Pick<Project, 'defaults'> | undefined,
  settings: Pick<GlobalSettings, 'defaults' | 'defaultTaskBudget'>,
): ResolvedAiConfig {
  const layers = [settings.defaults, project?.defaults ?? {}, task.ai];
  // Repos are one setting: a layer that names any (old `repo` or `repos`) replaces the rest.
  let repos: string[] | undefined;
  for (const layer of layers) {
    const named = repoList(layer as AiConfig);
    if (named.length) repos = named;
  }
  const pick = <K extends keyof AiConfig>(key: K): AiConfig[K] | undefined => {
    let value: AiConfig[K] | undefined;
    for (const layer of layers) {
      const v = (layer as AiConfig)[key];
      if (v !== undefined) value = v;
    }
    return value;
  };
  return {
    enabled: task.ai.enabled,
    model: pick('model') ?? 'auto',
    device: pick('device') ?? 'auto',
    budget: pick('budget') ?? settings.defaultTaskBudget,
    repos,
    folder: pick('folder'),
    browser: pick('browser'),
    tools: pick('tools'),
    toolsets: pick('toolsets'),
  };
}
