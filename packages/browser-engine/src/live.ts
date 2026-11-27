/**
 * The page as a live picture you can click into, over CDP: a screencast of the agent's tab and
 * your clicks, typing and scrolling replayed as real input events. The worker drives it on its
 * own line to the browser (the bridge's pipe), so no DevTools port or agent-browser live view
 * (a localhost WebSocket with input, reachable by anything on the machine) has to be opened.
 */

/** What LiveScreen needs from the browser: the bridge's own line (`CdpBridge`). */
export interface CdpLink {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
}

export interface LiveFrame {
  /** JPEG bytes. */
  jpeg: Buffer;
  /** The page's viewport in CSS pixels: input coordinates are given in these. */
  width: number;
  height: number;
  seq: number;
  url?: string;
}

/** Input from the person watching, in the frame's CSS pixels. */
export type LiveAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x: number; y: number; dy: number };

export interface LiveScreenOptions {
  onFrame: (frame: LiveFrame) => void;
  /** The page the agent is on: the tab to show when there are several. */
  preferUrl?: () => string | undefined;
  /** JPEG quality, 0 to 100. */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** How often to look for a new tab (a sign-in popup) or a closed one. */
  watchMs?: number;
  log?: (m: string) => void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

const KEYS: Record<string, { code: string; vk: number; text?: string; key?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Backspace: { code: 'Backspace', vk: 8 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
};

const isPage = (t: TargetInfo) =>
  t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension:');

export class LiveScreen {
  private session?: string;
  private targetId?: string;
  private url?: string;
  private known = new Set<string>();
  private seq = 0;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private switching?: Promise<void>;
  private listening = false;

  constructor(
    private readonly cdp: CdpLink,
    private readonly opts: LiveScreenOptions,
  ) {}

  /** Starts the picture on the agent's tab. Throws when there is no page to show. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (!this.listening) {
      this.listening = true;
      this.cdp.onEvent((method, params, sessionId) => this.event(method, params, sessionId));
    }
    const pages = await this.pages();
    for (const p of pages) this.known.add(p.targetId);
    const preferred = this.opts.preferUrl?.();
    const target = pages.find((p) => preferred && p.url === preferred) ?? pages.at(-1);
    if (!target) {
      this.running = false;
      throw new Error('no page is open');
    }
    await this.attach(target);
    this.timer = setInterval(() => void this.watch(), this.opts.watchMs ?? 1000);
  }

  /** Stops the picture and lets go of the tab; the agent's own control is untouched. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.switching?.catch(() => undefined);
    await this.detach();
  }

  get active(): boolean {
    return this.running && !!this.session;
  }

  /** Replays one action of the person watching on the tab shown. */
  async input(a: LiveAction): Promise<void> {
    const s = this.session;
    if (!this.running || !s) return;
    const mouse = (params: Record<string, unknown>) =>
      this.cdp.call('Input.dispatchMouseEvent', params, s);
    switch (a.type) {
      case 'click': {
        const at = { x: a.x, y: a.y };
        await mouse({ type: 'mouseMoved', ...at, button: 'none' });
        await mouse({ type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
        await mouse({ type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
        return;
      }
      case 'scroll':
        await mouse({ type: 'mouseWheel', x: a.x, y: a.y, deltaX: 0, deltaY: a.dy });
        return;
      case 'text':
        await this.cdp.call('Input.insertText', { text: a.text }, s);
        return;
      case 'key': {
        const k = KEYS[a.key];
        if (!k) return;
        const base = { key: k.key ?? a.key, code: k.code, windowsVirtualKeyCode: k.vk };
        await this.cdp.call(
          'Input.dispatchKeyEvent',
          { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) },
          s,
        );
        await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, s);
        return;
      }
    }
  }

  private async pages(): Promise<TargetInfo[]> {
    const { targetInfos } = (await this.cdp.call('Target.getTargets')) as {
      targetInfos: TargetInfo[];
    };
    return targetInfos.filter(isPage);
  }

  private async attach(target: TargetInfo): Promise<void> {
    const { sessionId } = (await this.cdp.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.session = sessionId;
    this.targetId = target.targetId;
    this.url = target.url;
    await this.cdp.call('Page.enable', {}, sessionId);
    await this.cdp.call(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: this.opts.quality ?? 60,
        maxWidth: this.opts.maxWidth ?? 1280,
        maxHeight: this.opts.maxHeight ?? 1280,
        everyNthFrame: 1,
      },
      sessionId,
    );
    // A page that does not repaint sends no frame of its own: a screenshot gives the first one.
    const shot = (await this.cdp
      .call(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: this.opts.quality ?? 60 },
        sessionId,
      )
      .catch(() => undefined)) as { data?: string } | undefined;
    const metrics = (await this.cdp
      .call('Page.getLayoutMetrics', {}, sessionId)
      .catch(() => undefined)) as
      | { cssVisualViewport?: { clientWidth: number; clientHeight: number } }
      | undefined;
    const vp = metrics?.cssVisualViewport;
    if (shot?.data && vp && this.session === sessionId)
      this.emit(shot.data, vp.clientWidth, vp.clientHeight);
  }

  private async detach(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    this.targetId = undefined;
    if (!s) return;
    await this.cdp.call('Page.stopScreencast', {}, s).catch(() => undefined);
    await this.cdp.call('Target.detachFromTarget', { sessionId: s }).catch(() => undefined);
  }

  /** Follows a new tab (a sign-in popup) and falls back when the shown tab closes. */
  private async watch(): Promise<void> {
    if (!this.running || this.switching) return;
    this.switching = (async () => {
      const pages = await this.pages();
      const fresh = pages.filter((p) => !this.known.has(p.targetId));
      for (const p of pages) this.known.add(p.targetId);
      const current = pages.find((p) => p.targetId === this.targetId);
      if (current) this.url = current.url;
      const next = fresh.at(-1) ?? (current ? undefined : pages.at(-1));
      if (!next || !this.running) return;
      this.opts.log?.(`live view: showing ${fresh.length ? 'the new tab' : 'another tab'}`);
      await this.detach();
      if (this.running) await this.attach(next);
    })()
      .catch((err: Error) => this.opts.log?.(`live view: ${err.message}`))
      .finally(() => {
        this.switching = undefined;
      });
    await this.switching;
  }

  private event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (!this.running || !sessionId || sessionId !== this.session) return;
    if (method !== 'Page.screencastFrame') return;
    const p = params as {
      data: string;
      sessionId: number;
      metadata: { deviceWidth: number; deviceHeight: number };
    };
    void this.cdp
      .call('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId)
      .catch(() => undefined);
    this.emit(p.data, p.metadata.deviceWidth, p.metadata.deviceHeight);
  }

  private emit(base64: string, width: number, height: number): void {
    this.opts.onFrame({
      jpeg: Buffer.from(base64, 'base64'),
      width,
      height,
      seq: ++this.seq,
      url: this.url,
    });
  }
}
