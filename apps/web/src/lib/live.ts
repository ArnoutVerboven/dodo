import type { LiveKey } from '@dodo/core';

/**
 * Where a click on the live picture lands on the page: the picture is drawn scaled to fit, so
 * the click is mapped back to the page's own pixels. Undefined outside the picture.
 */
export function toPagePoint(
  click: { clientX: number; clientY: number },
  box: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (!box.width || !box.height || !page.width || !page.height) return undefined;
  const fx = (click.clientX - box.left) / box.width;
  const fy = (click.clientY - box.top) / box.height;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return undefined;
  return { x: Math.round(fx * page.width), y: Math.round(fy * page.height) };
}

/** A key pressed on the focused picture: text to type, a key to press, or nothing to send. */
export function keyToInput(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): { text: string } | { key: LiveKey } | undefined {
  if (e.ctrlKey || e.metaKey) return undefined;
  if (e.key === ' ') return { key: 'Space' };
  const special: Record<string, LiveKey> = {
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Delete: 'Delete',
  };
  if (special[e.key]) return { key: special[e.key] as LiveKey };
  if ([...e.key].length === 1) return { text: e.key };
  return undefined;
}
