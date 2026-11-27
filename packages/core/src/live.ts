import { z } from 'zod';
import { Timestamp } from './model.js';

/**
 * Live takeover of the cloud browser. While a remote run holds its headless browser for an
 * answer (`Run.awaiting`), the owner can open the page live in the app: the worker streams
 * frames of the page into `runs/{runId}/live/view` and replays the owner's clicks, typing and
 * scrolling from `runs/{runId}/liveInput`. Firestore carries both, so nothing new runs or
 * listens in the cloud, and the browser's DevTools stay on the pipe only the worker holds.
 */

/** The owner opens or closes the live view (`runs/{runId}/live/control`). */
export const LiveControl = z.object({
  /** True while the owner has the live view open. */
  want: z.boolean(),
  at: Timestamp,
});
export type LiveControl = z.infer<typeof LiveControl>;

/**
 * What the worker shows (`runs/{runId}/live/view`): the latest frame of the page, at most a few
 * per second, and whether the view is on. `jpeg` is a Firestore Bytes value; the schema leaves
 * it out (the web app reads it with the SDK's Bytes type).
 */
export const LiveView = z.object({
  active: z.boolean(),
  /** Frame size in page pixels: where a click lands is given in these. */
  width: z.number().nonnegative().default(0),
  height: z.number().nonnegative().default(0),
  seq: z.number().int().nonnegative().default(0),
  url: z.string().optional(),
  /** Why the view is off or could not start, shown to the owner. */
  note: z.string().optional(),
  at: Timestamp,
});
export type LiveView = z.infer<typeof LiveView>;

/** Keys the live view can press besides typing text. */
export const LIVE_KEYS = [
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Delete',
  'Space',
] as const;
export const LiveKey = z.enum(LIVE_KEYS);
export type LiveKey = z.infer<typeof LiveKey>;

/** One thing the owner does on the page (`runs/{runId}/liveInput/{id}`), in page pixels. */
export const LiveInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    at: Timestamp,
  }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(500), at: Timestamp }),
  z.object({ type: z.literal('key'), key: LiveKey, at: Timestamp }),
  z.object({
    type: z.literal('scroll'),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    dy: z.number().min(-5000).max(5000),
    at: Timestamp,
  }),
]);
export type LiveInput = z.infer<typeof LiveInput>;

/** At most this many frames per second go to Firestore (one document, one writer). */
export const LIVE_MAX_FPS = 2;
