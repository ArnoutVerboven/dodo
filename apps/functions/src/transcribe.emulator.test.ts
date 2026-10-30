import { monthKey } from '@dodo/budget';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_HOURLY_CAP } from './gateway.js';
import { FakeProvider } from './model-provider.js';
import { costGateFor } from './runtime.js';
import { transcribeCost, transcribeWithBudget } from './transcribe.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'transcribe-test') : undefined;
const db = app ? getFirestore(app) : undefined;

describe('transcribeCost', () => {
  it('bills a minute of audio at about €0.002', () => {
    const minute = transcribeCost(1920, 0);
    expect(minute).toBeGreaterThanOrEqual(1920);
    expect(minute).toBeLessThanOrEqual(1921);
    expect(transcribeCost(0, 0)).toBe(0);
  });
});

describe.skipIf(!enabled)('transcribeWithBudget', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  it('charges the month and the lifetime total, never a task', async () => {
    const d = db as NonNullable<typeof db>;
    const now = Date.UTC(2031, 4, 2);
    const month = monthKey(now);
    const before = (await d.doc(paths.budget(`global_${month}`)).get()).data()?.spent ?? 0;
    const r = await transcribeWithBudget(
      {
        db: d,
        costGate: costGateFor(d),
        provider: new FakeProvider(),
        hourlyCap: DEFAULT_HOURLY_CAP,
        now: () => now,
      },
      { audio: 'AAAA', mimeType: 'audio/webm;codecs=opus', language: 'nl-BE' },
    );
    expect(r.text).toBe('Fake transcript of your voice note.');
    expect(r.cost).toBe(transcribeCost(1920, 10));

    const global = (await d.doc(paths.budget(`global_${month}`)).get()).data();
    expect(global?.spent).toBe(before + r.cost);
    expect(global?.reserved ?? 0).toBe(0);
    const ledger = await d
      .collection(paths.ledger())
      .where('description', '==', 'push-to-talk transcription')
      .get();
    expect(ledger.docs.some((e) => e.get('taskId') !== undefined)).toBe(false);
  });
});
