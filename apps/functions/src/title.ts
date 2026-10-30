import { scopesForTask } from '@dodo/budget';
import {
  type GlobalSettings,
  isLocalModel,
  type Project,
  paths,
  resolveAiConfig,
  type Task,
  TITLE_SYSTEM,
} from '@dodo/core';
import { type GatewayDeps, generateWithBudget } from './gateway.js';

const TITLE_MODEL = 'gemini-3.1-flash-lite';

/** A title without a model: the description's first line, cut at a word near 60 characters. */
export function plainTitle(description: string): string {
  const line =
    description
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/**
 * Tasks created without a title get one from the cheapest model, charged to the task. A task
 * on the local model stays off Gemini entirely: its title is its first line instead.
 */
export async function generateTitle(
  deps: GatewayDeps,
  taskId: string,
): Promise<string | undefined> {
  const ref = deps.db.doc(paths.task(taskId));
  const task = (await ref.get()).data();
  if (task?.titleSource !== 'ai' || !task.description?.trim()) return undefined;
  if (await usesLocalModel(deps, task as Task)) {
    const title = plainTitle(String(task.description));
    if (title) await ref.update({ title, updatedAt: Date.now() });
    return title || undefined;
  }
  const res = await generateWithBudget(
    deps,
    {
      scopes: scopesForTask(taskId, task.projectId, Date.now()),
      taskId,
      projectId: task.projectId,
      description: 'title generation',
    },
    {
      model: TITLE_MODEL,
      systemInstruction: TITLE_SYSTEM,
      contents: [{ role: 'user', parts: [{ text: String(task.description).slice(0, 4000) }] }],
      maxOutputTokens: 256,
      thinkingBudget: 0,
      temperature: 0.2,
    },
  );
  const title = res.content.parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 100);
  if (!title) return undefined;
  await ref.update({ title, updatedAt: Date.now() });
  return title;
}

/** The task's model after project and global defaults: is it the local one? */
export async function usesLocalModel(
  deps: Pick<GatewayDeps, 'db'>,
  task: Pick<Task, 'ai' | 'projectId'>,
): Promise<boolean> {
  if (task.ai?.model) return isLocalModel(task.ai.model);
  const [project, settings] = await Promise.all([
    task.projectId
      ? deps.db
          .doc(paths.project(task.projectId))
          .get()
          .then((s) => s.data() as Project | undefined)
      : undefined,
    deps.db
      .doc(paths.settings())
      .get()
      .then((s) => (s.data() ?? {}) as Partial<GlobalSettings>),
  ]);
  const ai = resolveAiConfig({ ai: task.ai ?? { enabled: false } }, project, {
    defaults: settings.defaults ?? {},
    defaultTaskBudget: settings.defaultTaskBudget ?? 0,
  });
  return isLocalModel(ai.model);
}
