import type { TranscribeRequest, TranscribeResponse } from '@dodo/core';
import { httpsCallable } from 'firebase/functions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { functions } from '@/lib/firebase';

/** Longest voice note: it stops by itself after this, and the server sizes its budget for it. */
export const MAX_RECORDING_MS = 3 * 60_000;
/** A press shorter than this is a tap: recording keeps going until the next tap. */
const TAP_MS = 400;
/** Shorter than this after release is a slip of the finger, not a note. */
const MIN_RECORDING_MS = 500;

export type PushToTalkState = 'idle' | 'starting' | 'recording' | 'transcribing';

/** The first container this browser can record: webm/opus (Chrome, Firefox), mp4 (Safari, iOS). */
function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t));
}

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });

const transcribeCall = httpsCallable<TranscribeRequest, TranscribeResponse>(
  functions,
  'transcribe',
  { timeout: 120_000 },
);

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone blocked: allow it for this site in the browser settings.';
  if (name === 'NotFoundError') return 'No microphone found.';
  const message = (err as { message?: string })?.message;
  return message ? `Could not transcribe: ${message}` : 'Could not transcribe the recording.';
}

/**
 * Push-to-talk: record a voice note in the browser and have Gemini transcribe it (see
 * `transcribe` in the functions). Hold the button to talk and release to stop, or tap once to
 * start and tap again to stop. The text goes to `onText`, for the field to append.
 *
 * Recording uses MediaRecorder rather than the browser's own speech recognition, which is
 * missing in Firefox and unreliable on phones (an iOS home-screen app, Android's continuous mode).
 */
export function usePushToTalk(onText: (text: string) => void) {
  const [supported] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof MediaRecorder !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia,
  );
  const [state, setState] = useState<PushToTalkState>('idle');
  /** `hold`: stops on release. `toggle`: a tap started it, the next tap stops it. */
  const [mode, setMode] = useState<'hold' | 'toggle'>('hold');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handler = useRef(onText);
  handler.current = onText;
  const stateRef = useRef<PushToTalkState>('idle');
  const modeRef = useRef<'hold' | 'toggle'>('hold');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pressedAt = useRef(0);
  const released = useRef(false);
  const startedAt = useRef(0);
  const timers = useRef<number[]>([]);
  const mounted = useRef(true);

  const set = useCallback((s: PushToTalkState) => {
    stateRef.current = s;
    if (mounted.current) setState(s);
  }, []);
  const setModeBoth = useCallback((m: 'hold' | 'toggle') => {
    modeRef.current = m;
    setMode(m);
  }, []);
  const clearTimers = () => {
    for (const t of timers.current) window.clearInterval(t);
    timers.current = [];
  };
  const releaseMic = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  };

  const stop = useCallback(() => {
    const r = recorder.current;
    if (r && r.state !== 'inactive') r.stop();
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, mimeType: string) => {
      set('transcribing');
      try {
        const audio = await blobToBase64(blob);
        const res = await transcribeCall({ audio, mimeType, language: navigator.language });
        const text = res.data.text.trim();
        if (text) handler.current(text);
        else if (mounted.current) setError('No speech heard.');
      } catch (err) {
        if (mounted.current) setError(micError(err));
      } finally {
        set('idle');
      }
    },
    [set],
  );

  const begin = useCallback(async () => {
    setError(null);
    set('starting');
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setError(micError(err));
      set('idle');
      return;
    }
    if (!mounted.current) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    stream.current = media;
    const preferred = pickMimeType();
    let r: MediaRecorder;
    try {
      r = new MediaRecorder(media, {
        ...(preferred ? { mimeType: preferred } : {}),
        audioBitsPerSecond: 32_000,
      });
    } catch (err) {
      releaseMic();
      setError(micError(err));
      set('idle');
      return;
    }
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    r.onstop = () => {
      clearTimers();
      releaseMic();
      recorder.current = null;
      const duration = Date.now() - startedAt.current;
      const mimeType = r.mimeType || preferred || 'audio/webm';
      const blob = new Blob(chunks, { type: mimeType });
      if (!mounted.current) return;
      if (duration < MIN_RECORDING_MS || blob.size === 0) {
        set('idle');
        return;
      }
      void transcribe(blob, mimeType);
    };
    recorder.current = r;
    startedAt.current = Date.now();
    setElapsed(0);
    r.start();
    set('recording');
    // Released while the browser was still asking for the microphone: keep recording, and
    // the next tap stops it, rather than dropping what they meant to say.
    if (released.current) setModeBoth('toggle');
    timers.current.push(
      window.setInterval(() => {
        const ms = Date.now() - startedAt.current;
        setElapsed(Math.floor(ms / 1000));
        if (ms >= MAX_RECORDING_MS) stop();
      }, 250),
    );
  }, [set, setModeBoth, stop, transcribe]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
      const r = recorder.current;
      if (r && r.state !== 'inactive') r.stop();
      releaseMic();
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const s = stateRef.current;
      if (s === 'transcribing') return;
      if (s === 'recording' || s === 'starting') {
        // A second tap in tap mode stops it.
        if (modeRef.current === 'toggle') stop();
        return;
      }
      // Keep the pointer on the button while the finger moves, so a wobble does not stop it.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      pressedAt.current = Date.now();
      released.current = false;
      setModeBoth('hold');
      void begin();
    },
    [begin, setModeBoth, stop],
  );

  const onPointerUp = useCallback(() => {
    if (modeRef.current !== 'hold' || released.current) return;
    released.current = true;
    const s = stateRef.current;
    if (s === 'starting') return; // begin() switches to tap mode once the mic is on
    if (s !== 'recording') return;
    if (Date.now() - pressedAt.current < TAP_MS) setModeBoth('toggle');
    else stop();
  }, [setModeBoth, stop]);

  /** Keyboard (Enter, Space): a click with no pointer behind it toggles. */
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.detail !== 0) return;
      const s = stateRef.current;
      if (s === 'recording') stop();
      else if (s === 'idle') {
        released.current = true;
        setModeBoth('toggle');
        void begin();
      }
    },
    [begin, setModeBoth, stop],
  );

  return {
    supported,
    state,
    mode,
    elapsed,
    error,
    buttonProps: {
      onPointerDown,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClick,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

export const formatElapsed = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
