import { type LiveInput, type LiveKey, LiveView, paths, type Run } from '@dodo/core';
import { addDoc, type Bytes, collection, doc, onSnapshot, setDoc } from 'firebase/firestore';
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Delete,
  Loader2,
  MonitorSmartphone,
  Send,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { db } from '@/lib/firebase';
import { keyToInput, toPagePoint } from '@/lib/live';

/**
 * Live takeover of the cloud browser: while the run holds its page for your answer, the page
 * shows here and your clicks, typing and scrolling go to it (the worker replays them). For the
 * steps the agent cannot do: a CAPTCHA, an itsme QR code to scan with your phone.
 */

export type LiveFrameState = { view: LiveView; src?: string };

/** The run's live view: whether it is offered, and the latest frame as an image URL. */
export function useLiveView(runId: string | undefined): LiveFrameState | undefined {
  const [frame, setFrame] = useState<LiveFrameState>();
  useEffect(() => {
    if (!runId) return;
    let url: string | undefined;
    const off = onSnapshot(
      doc(db, paths.runLiveView(runId)),
      (snap) => {
        if (!snap.exists()) return setFrame(undefined);
        const data = snap.data();
        const view = LiveView.safeParse(data);
        if (!view.success) return setFrame(undefined);
        const jpeg = data.jpeg as Bytes | null | undefined;
        if (url) URL.revokeObjectURL(url);
        url = jpeg?.toUint8Array
          ? URL.createObjectURL(
              new Blob([new Uint8Array(jpeg.toUint8Array())], { type: 'image/jpeg' }),
            )
          : undefined;
        setFrame({ view: view.data, src: url });
      },
      () => setFrame(undefined),
    );
    return () => {
      off();
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId]);
  return frame;
}

const control = (runId: string, want: boolean) =>
  setDoc(doc(db, paths.runLiveControl(runId)), { want, at: Date.now() });

/** Sends one action to the page. Inputs are plain data: the worker checks them again. */
type Action = LiveInput extends infer T ? (T extends unknown ? Omit<T, 'at'> : never) : never;

const send = (runId: string, input: Action) =>
  addDoc(collection(db, paths.runLiveInput(runId)), { ...input, at: Date.now() }).catch((err) =>
    console.error('Could not send to the page', err),
  );

const KEY_BUTTONS: Array<{ key: LiveKey; label: string; icon?: typeof Delete }> = [
  { key: 'Enter', label: 'Enter', icon: CornerDownLeft },
  { key: 'Backspace', label: 'Delete back', icon: Delete },
  { key: 'Tab', label: 'Tab' },
  { key: 'Escape', label: 'Esc' },
];

export function LiveBrowser({
  run,
  frame,
  onDone,
}: {
  run: Run;
  /** From useLiveView, which the caller already holds to know the view is offered. */
  frame: LiveFrameState | undefined;
  onDone: () => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const [text, setText] = useState('');
  const [waited, setWaited] = useState(false);
  // On a phone the page is drawn small: zoomed, it is twice as wide and scrolls sideways.
  const [zoom, setZoom] = useState(false);
  const openedAt = useRef(Date.now());
  const typed = useRef('');
  const typeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrollBy = useRef(0);
  const scrollAt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Opening the view asks the worker to start it; leaving the page or Done stops it.
  useEffect(() => {
    void control(run.id, true);
    const t = setTimeout(() => setWaited(true), 15_000);
    return () => {
      clearTimeout(t);
      void control(run.id, false);
    };
  }, [run.id]);

  const view = frame?.view;
  const page = view?.active ? { width: view.width, height: view.height } : undefined;

  const point = (e: { clientX: number; clientY: number }) => {
    const el = img.current;
    if (!el || !page) return undefined;
    return toPagePoint(e, el.getBoundingClientRect(), page);
  };

  // Typed characters go out in small batches, not one write per key.
  const flushTyped = () => {
    if (typed.current) void send(run.id, { type: 'text', text: typed.current });
    typed.current = '';
  };

  // The wheel scrolls the page, not this one: a non-passive listener can keep it.
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      scrollBy.current += e.deltaY;
      scrollAt.current = p;
      if (scrollTimer.current) return;
      scrollTimer.current = setTimeout(() => {
        scrollTimer.current = undefined;
        const dy = Math.max(-5000, Math.min(5000, Math.round(scrollBy.current)));
        scrollBy.current = 0;
        if (dy) void send(run.id, { type: 'scroll', ...scrollAt.current, dy });
      }, 150);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const held = run.awaiting?.until;
  // A note the worker wrote since you opened the view (its clock may differ a little).
  const status = !view?.active
    ? view?.note && view.at >= openedAt.current - 5_000
      ? view.note
      : waited
        ? 'The page has not come up. The agent may have the page again, or this run cannot show it.'
        : 'Opening the page…'
    : undefined;

  return (
    <div className="mt-2 space-y-2 rounded-lg border bg-card p-2" data-live-browser>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <MonitorSmartphone className="h-3.5 w-3.5" /> Live page
        </span>
        {view?.url && <span className="min-w-0 truncate">{view.url}</span>}
        {held && (
          <span className="ml-auto">
            Held until{' '}
            {new Date(held).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {page && frame?.src ? (
        <div className="overflow-auto rounded-md">
          <button
            type="button"
            aria-label="The agent's browser page, live. Click or tap to use it; typing goes to the page."
            className={`block cursor-pointer touch-manipulation rounded-md p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring ${zoom ? 'w-[200%] max-w-none' : 'w-full'}`}
            onClick={(e) => {
              e.currentTarget.focus();
              const p = point(e);
              if (p) void send(run.id, { type: 'click', ...p });
            }}
            onKeyDown={(e) => {
              const input = keyToInput(e);
              if (!input) return;
              e.preventDefault();
              if ('text' in input) {
                typed.current += input.text;
                clearTimeout(typeTimer.current);
                typeTimer.current = setTimeout(flushTyped, 150);
              } else {
                flushTyped();
                void send(run.id, { type: 'key', key: input.key });
              }
            }}
          >
            <img
              ref={img}
              src={frame.src}
              alt=""
              className="block w-full select-none rounded-md border bg-white"
              draggable={false}
            />
          </button>
        </div>
      ) : (
        <div className="flex h-48 items-center justify-center gap-2 rounded-md border bg-muted px-4 text-center text-sm text-muted-foreground">
          {!waited && !view?.note && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
          {status}
        </div>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          void send(run.id, { type: 'text', text: text.slice(0, 500) });
          setText('');
        }}
      >
        <Input
          id={`live-type-${run.id}`}
          className="h-9 min-w-0 flex-1"
          placeholder="Type into the field you clicked…"
          aria-label="Text to type on the page"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!page}
        />
        <Button type="submit" size="icon" aria-label="Type it" disabled={!page || !text}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {KEY_BUTTONS.map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            size="sm"
            variant="outline"
            disabled={!page}
            aria-label={label}
            title={label}
            onClick={() => void send(run.id, { type: 'key', key })}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : label}
          </Button>
        ))}
        {[-1, 1].map((dir) => (
          <Button
            key={dir}
            size="sm"
            variant="outline"
            disabled={!page}
            aria-label={dir < 0 ? 'Scroll up' : 'Scroll down'}
            onClick={() =>
              page &&
              void send(run.id, {
                type: 'scroll',
                x: Math.round(page.width / 2),
                y: Math.round(page.height / 2),
                dy: dir * Math.round(page.height * 0.6),
              })
            }
          >
            {dir < 0 ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={!page}
          aria-pressed={zoom}
          onClick={() => setZoom((z) => !z)}
        >
          {zoom ? 'Fit' : 'Zoom'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onDone}>
          Done, hand the page back
        </Button>
        <p className="text-xs text-muted-foreground">
          The agent waits while you use the page, and looks at it again when you are done.
        </p>
      </div>
    </div>
  );
}
