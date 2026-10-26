import { scopesForTask } from '@dodo/budget';
import { paths } from '@dodo/core';
import { type GatewayDeps, generateWithBudget } from './gateway.js';

const TITLE_MODEL = 'gemini-2.5-flash-lite';

/** Tasks created without a title get one from the cheapest model, charged to the task. */
export async function generateTitle(
  deps: GatewayDeps,
  taskId: string,
): Promise<string | undefined> {
  const ref = deps.db.doc(paths.task(taskId));
  const task = (await ref.get()).data();
  if (task?.titleSource !== 'ai' || !task.description?.trim()) return undefined;
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
      systemInstruction:
        'Write a task title of at most 8 words for the description. Reply with the title only, no quotes, no trailing period.',
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
