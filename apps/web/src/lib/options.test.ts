import { describe, expect, it } from 'vitest';
import { pickDevice } from './options';

describe('pickDevice', () => {
  it('swaps the local model for the cloud default when Remote is picked', () => {
    expect(pickDevice('gcp', { model: 'local' })).toEqual({ device: 'gcp', model: 'auto' });
    expect(pickDevice('gcp', { model: 'local:qwen3' })).toEqual({ device: 'gcp', model: 'auto' });
    expect(pickDevice('gcp', { model: 'local' }, { model: 'local' })).toEqual({
      device: 'gcp',
      model: 'auto',
    });
  });

  it('falls back to an inherited cloud model', () => {
    const patch = pickDevice('gcp', { model: 'local' }, { model: 'gemini-3.5-flash' });
    expect(patch).toEqual({ device: 'gcp', model: undefined });
    expect('model' in patch).toBe(true);
  });

  it('leaves the model alone otherwise', () => {
    expect(pickDevice('gcp', { model: 'gemini-3.5-flash' })).toEqual({ device: 'gcp' });
    expect(pickDevice('gcp', {})).toEqual({ device: 'gcp' });
    expect(pickDevice('mac:abc', { model: 'local' })).toEqual({ device: 'mac:abc' });
    expect(pickDevice('auto', { model: 'local' })).toEqual({ device: 'auto' });
  });
});
