import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEur(micro: number, digits = 2): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) }).format(micro / 1_000_000);
}

/** Euros rounded to the cent: "€0.01". */
export function formatEurCents(micro: number): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(micro / 1_000_000);
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * A URL safe to put in an `<a href>`: http(s) only. Links come from the agent and from task
 * sources, and a `javascript:` URL would run in your session when clicked.
 */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A pairing code (devices, Telegram): 12 random lowercase letters and digits, ~62 bits. */
export function pairingCode(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // 36 does not divide 256; rejection keeps the draw uniform.
  let out = '';
  while (out.length < 12) {
    for (const b of bytes) {
      if (out.length < 12 && b < 252) out += alphabet[b % 36];
    }
    if (out.length < 12) crypto.getRandomValues(bytes);
  }
  return out;
}

/** True when a key event comes from a field the user is typing in, so shortcuts stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}
