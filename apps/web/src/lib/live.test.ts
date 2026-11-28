import { describe, expect, it } from 'vitest';
import { keyToInput, toPagePoint } from './live';

describe('toPagePoint', () => {
  const box = { left: 100, top: 50, width: 400, height: 300 };
  const page = { width: 1280, height: 960 };
  it('maps a click on the scaled picture to page pixels', () => {
    expect(toPagePoint({ clientX: 100, clientY: 50 }, box, page)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint({ clientX: 300, clientY: 200 }, box, page)).toEqual({ x: 640, y: 480 });
    expect(toPagePoint({ clientX: 500, clientY: 350 }, box, page)).toEqual({ x: 1280, y: 960 });
  });
  it('ignores clicks outside the picture or before the first frame', () => {
    expect(toPagePoint({ clientX: 99, clientY: 60 }, box, page)).toBeUndefined();
    expect(toPagePoint({ clientX: 200, clientY: 200 }, box, { width: 0, height: 0 })).toBeUndefined();
  });
});

describe('keyToInput', () => {
  it('types characters and presses the keys a form needs', () => {
    expect(keyToInput({ key: 'a' })).toEqual({ text: 'a' });
    expect(keyToInput({ key: 'é' })).toEqual({ text: 'é' });
    expect(keyToInput({ key: ' ' })).toEqual({ key: 'Space' });
    expect(keyToInput({ key: 'Enter' })).toEqual({ key: 'Enter' });
    expect(keyToInput({ key: 'Backspace' })).toEqual({ key: 'Backspace' });
  });
  it('leaves shortcuts and other keys alone', () => {
    expect(keyToInput({ key: 'c', metaKey: true })).toBeUndefined();
    expect(keyToInput({ key: 'v', ctrlKey: true })).toBeUndefined();
    expect(keyToInput({ key: 'Shift' })).toBeUndefined();
    expect(keyToInput({ key: 'F5' })).toBeUndefined();
  });
});
