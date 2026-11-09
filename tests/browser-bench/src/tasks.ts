import { readFileSync } from 'node:fs';

/**
 * What the bench asks each approach to do. Every task stops before anything that needs a
 * password or changes an account, so a run is safe to repeat; success is checked on the page
 * the agent ends on, not on what the agent says.
 */
export interface Task {
  id: string;
  /** Where the browser starts. `{fixture}` is the local test shop. */
  start: string;
  goal: string;
  /** The final page's URL must match this (a regular expression), when given. */
  url?: string;
  /** The final page's text must match this (case-insensitive), when given. */
  text?: string;
  /** Local test shop (runs offline) or a real site. */
  where: 'fixture' | 'live';
}

const STOP = 'Stop there and call done; do not type anything into the form or log in.';

export const TASKS: Task[] = [
  {
    id: 'shop-email-login',
    where: 'fixture',
    start: '{fixture}/',
    goal: `Open the log-in form where you enter an email address and a password (log in with email, not Google). ${STOP}`,
    url: '/member/login/email',
  },
  {
    id: 'shop-google-login',
    where: 'fixture',
    start: '{fixture}/',
    goal: `Start logging in with Google, and stop on the Google sign-in page. ${STOP}`,
    url: '/auth/google',
  },
  {
    id: 'shop-search',
    where: 'fixture',
    start: '{fixture}/',
    goal: 'Search for "Nike Air Max 90" and open the first listing in the results, then call done.',
    url: '/items/\\d+',
    text: 'Nike Air Max 90',
  },
  {
    id: 'vinted-email-login',
    where: 'live',
    start: 'https://www.vinted.be/',
    goal: `On Vinted, open the log-in form where you enter your email and password (choose log in with email, not Google, Apple or Facebook). ${STOP}`,
    url: '/member/login/email',
  },
  {
    id: 'vinted-google-login',
    where: 'live',
    start: 'https://www.vinted.be/',
    goal: `On Vinted, start logging in with Google and stop on the Google sign-in page (accounts.google.com). ${STOP}`,
    url: 'accounts\\.google\\.com',
  },
  {
    id: 'vinted-search',
    where: 'live',
    start: 'https://www.vinted.be/',
    goal: 'On Vinted, search for "Nike Air Max 90" and open the first listing in the results, then call done.',
    url: '/items/\\d+',
  },
  {
    id: 'booking-google-login',
    where: 'live',
    start: 'https://www.booking.com/',
    goal: `On Booking.com, go to sign in and stop when the "Continue with Google" option is on screen. ${STOP}`,
    url: 'account\\.booking\\.com',
    text: 'google',
  },
  {
    id: 'booking-search',
    where: 'live',
    start: 'https://www.booking.com/',
    goal: 'On Booking.com, search for stays in Ghent (any dates the site offers, 2 adults) and stop on the results list, then call done.',
    url: 'searchresults',
    text: 'ghent|gent',
  },
  {
    id: 'overleaf-login',
    where: 'live',
    start: 'https://www.overleaf.com/',
    goal: `On Overleaf, open the log-in page. ${STOP}`,
    url: 'overleaf\\.com/login',
  },
  {
    id: 'engie-itsme',
    where: 'live',
    start: 'https://www.engie.be/',
    goal: `On ENGIE Belgium, open the log-in for My ENGIE (customer area) and stop when the itsme option is on screen. ${STOP}`,
    text: 'itsme',
  },
];

/** The built-in tasks, or your own from a JSON file with the same fields. */
export function loadTasks(file?: string): Task[] {
  if (!file) return TASKS;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Task[];
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of tasks`);
  return parsed.map((t) => ({ ...t, where: t.where ?? 'live' }));
}

export function passed(task: Task, final: { url: string; text: string }): boolean {
  if (task.url && !new RegExp(task.url).test(final.url)) return false;
  if (task.text && !new RegExp(task.text, 'i').test(final.text)) return false;
  return Boolean(task.url || task.text);
}
