import type { Message, ToolSpec } from '../model.ts';

/** One way of letting a model drive a browser: the tools it sees and what each returns. */
export interface Driver {
  tools: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Where the browser ended up, read by the bench itself (not counted as model tokens). */
  finalState(): Promise<{ url: string; text: string }>;
  /** Optional history rewrite before each model call (e.g. drop old page snapshots). */
  prune?(messages: Message[]): void;
  /** Playwright code the run executed, for the replay approach. */
  recorded?(): string[];
  close(): Promise<void>;
}

export interface DriverOptions {
  headed: boolean;
  /** A Chrome or Chromium binary; empty means the tool's default (Chrome on a Mac). */
  executablePath?: string;
  workdir: string;
  /** Linux containers running as root need Chromium's sandbox off. */
  noSandbox?: boolean;
}

/** Roles worth keeping when only the interactive part of a page is shown. */
export const INTERACTIVE =
  /^\s*- (button|link|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton|heading|dialog|alertdialog|alert)\b/;
