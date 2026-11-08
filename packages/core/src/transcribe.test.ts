import { describe, expect, it } from 'vitest';
import { TranscribeRequest } from './run.js';

describe('TranscribeRequest', () => {
  const ok = (mimeType: string) => TranscribeRequest.safeParse({ audio: 'AAAA', mimeType }).success;

  it('takes what MediaRecorder reports in each browser', () => {
    expect(ok('audio/webm')).toBe(true);
    expect(ok('audio/webm;codecs=opus')).toBe(true);
    expect(ok('audio/mp4')).toBe(true);
    expect(ok('audio/mp4; codecs="mp4a.40.2"')).toBe(true);
    expect(ok('audio/ogg;codecs=opus')).toBe(true);
  });

  it('refuses anything that is not audio', () => {
    expect(ok('video/webm')).toBe(false);
    expect(ok('text/html')).toBe(false);
    expect(ok('')).toBe(false);
  });
});
