import { randomUUID } from 'node:crypto';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueRun, onInputAnswered } from './triggers.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'triggers-test') : undefined;
const db = app ? getFirestore(app) : undefined;

/** What answering a card does: always-allow rules, budget top-ups, and the resume. */
describe.skipIf(!enabled)('onInputAnswered', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seedTask(patch: Record<string, unknown> = {}) {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const projectId = `p-${randomUUID()}`;
    await d.doc(paths.project(projectId)).set({ name: 'P', createdAt: 1, updatedAt: 1 });
    await d.doc(paths.task(taskId)).set({
      title: 'Answer me',
      description: '',
      status: 'needs_input',
      projectId,
      ai: { enabled: true, device: 'gcp', budget: 300_000 },
      createdAt: 1,
      updatedAt: 1,
      ...patch,
    });
    return { taskId, projectId };
  }
  const runsOf = async (taskId: string) =>
    (
      await (db as NonNullable<typeof db>)
        .collection(paths.runs())
        .where('taskId', '==', taskId)
        .get()
    ).docs;

  it('a yes to a top-up raises the task budget and resumes with the answer', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId } = await seedTask();
    await onInputAnswered(
      { db: d },
      taskId,
      'm1',
      { input: {} },
      {
        input: { prompt: 'Top up?', topUp: 500_000, answer: { value: 'yes' } },
      },
    );
    const task = (await d.doc(paths.task(taskId)).get()).data();
    expect(task?.ai?.budget).toBe(800_000);
    const runs = await runsOf(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.get('trigger')).toBe('resume');
    expect(runs[0]?.get('answer')?.value).toBe('yes');
  });

  it('a no to a top-up leaves the budget and starts nothing', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId } = await seedTask();
    await onInputAnswered(
      { db: d },
      taskId,
      'm1',
      { input: {} },
      {
        input: { prompt: 'Top up?', topUp: 500_000, answer: { value: 'no' } },
      },
    );
    const task = (await d.doc(paths.task(taskId)).get()).data();
    expect(task?.ai?.budget).toBe(300_000);
    expect(task?.status).toBe('needs_input');
    expect(await runsOf(taskId)).toHaveLength(0);
  });

  it('does nothing when the answer was already there (a replayed event)', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId } = await seedTask();
    const answered = { prompt: 'Top up?', topUp: 500_000, answer: { value: 'yes' } };
    await onInputAnswered({ db: d }, taskId, 'm1', { input: answered }, { input: answered });
    expect((await d.doc(paths.task(taskId)).get()).get('ai.budget')).toBe(300_000);
    expect(await runsOf(taskId)).toHaveLength(0);
  });

  for (const scope of ['task', 'project'] as const) {
    it(`"allow always" for the ${scope} saves the rule there`, async () => {
      const d = db as NonNullable<typeof db>;
      const { taskId, projectId } = await seedTask();
      const rule = `Bash(npm test ${randomUUID().slice(0, 6)})`;
      await onInputAnswered(
        { db: d },
        taskId,
        'm1',
        { input: {} },
        {
          input: {
            prompt: `Allow ${rule}?`,
            suggestedRule: rule,
            answer: { value: 'yes', alwaysAllow: { rule, scope } },
          },
        },
      );
      const doc = scope === 'task' ? paths.task(taskId) : paths.project(projectId);
      expect((await d.doc(doc).get()).get('allowRules')).toContain(rule);
      const runs = await runsOf(taskId);
      expect(runs[0]?.get('answer')?.alwaysAllow).toBe(true);
    });
  }

  it('hands the answer to a run holding for it instead of starting another', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId } = await seedTask({ status: 'in_progress' });
    const runId = await enqueueRun({ db: d }, taskId, { trigger: 'new' });
    expect(runId).toBeDefined();
    await d.doc(paths.run(runId as string)).update({
      state: 'running',
      awaiting: { messageId: 'held', until: Date.now() + 600_000 },
      lease: { owner: `run:${runId}`, expiresAt: Date.now() + 3_600_000 },
    });
    await onInputAnswered(
      { db: d },
      taskId,
      'held',
      { input: {} },
      {
        input: { prompt: 'Code?', answer: { value: '123456' } },
      },
    );
    expect(await runsOf(taskId)).toHaveLength(1);
  });
});
