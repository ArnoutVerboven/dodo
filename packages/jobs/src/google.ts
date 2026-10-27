import { GOOGLE_SCOPES } from './model.js';

/**
 * Google OAuth (web server flow) and thin REST clients for Gmail and Calendar, on plain
 * `fetch`: no SDK, so nothing heavy loads into every function's cold start.
 */

export type Fetch = typeof fetch;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** The refresh token is no longer valid: the user must connect again. */
    readonly reconnect = false,
  ) {
    super(message);
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function authUrl(client: OAuthClient, state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even when it was granted before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenCall(f: Fetch, body: Record<string, string>): Promise<TokenResponse> {
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const reconnect = json.error === 'invalid_grant';
    throw new GoogleAuthError(
      `Google token endpoint: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim(),
      reconnect,
    );
  }
  return json;
}

export interface ExchangedTokens {
  refreshToken: string;
  scopes: string[];
  email?: string;
}

/** Code from the consent redirect → refresh token, granted scopes and the account's address. */
export async function exchangeCode(
  f: Fetch,
  client: OAuthClient,
  code: string,
): Promise<ExchangedTokens> {
  const t = await tokenCall(f, {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!t.refresh_token) throw new GoogleAuthError('Google returned no refresh token');
  return {
    refreshToken: t.refresh_token,
    scopes: (t.scope ?? '').split(/\s+/).filter(Boolean),
    email: t.id_token ? emailFromIdToken(t.id_token) : undefined,
  };
}

/**
 * The id token comes straight from Google's token endpoint over TLS, so reading its payload
 * without verifying the signature is safe here (it is only used to show the address).
 */
export function emailFromIdToken(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

export async function revokeToken(f: Fetch, token: string): Promise<void> {
  await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/** Missing scopes: Google lets the user untick boxes on the consent screen. */
export function missingScopes(granted: string[]): string[] {
  const have = new Set(granted);
  return GOOGLE_SCOPES.filter(
    (s) => s.startsWith('https://') && !have.has(s),
  ) as unknown as string[];
}

/** Access tokens from a refresh token, cached until shortly before they expire. */
export class GoogleSession {
  private cached?: { token: string; until: number };
  constructor(
    private readonly f: Fetch,
    private readonly client: Pick<OAuthClient, 'clientId' | 'clientSecret'>,
    private readonly refreshToken: () => Promise<string | undefined>,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.until > this.now()) return this.cached.token;
    const refresh = await this.refreshToken();
    if (!refresh) throw new GoogleAuthError('Google is not connected', true);
    const t = await tokenCall(this.f, {
      refresh_token: refresh,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      grant_type: 'refresh_token',
    });
    this.cached = { token: t.access_token, until: this.now() + (t.expires_in - 120) * 1000 };
    return t.access_token;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await this.f(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status === 401) {
      this.cached = undefined;
      throw new GoogleAuthError('Google rejected the access token', false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GoogleApiError(res.status, `Google API ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/* ------------------------------- Gmail ------------------------------- */

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}
export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailClient {
  constructor(private readonly s: GoogleSession) {}

  profile() {
    return this.s.request<{ emailAddress: string }>(`${GMAIL}/profile`);
  }

  async listThreads(q: string, max: number): Promise<Array<{ id: string; historyId?: string }>> {
    const res = await this.s.request<{ threads?: Array<{ id: string; historyId?: string }> }>(
      `${GMAIL}/threads?${new URLSearchParams({ q, maxResults: String(max) })}`,
    );
    return res.threads ?? [];
  }

  /** `metadata` reads headers and labels only; `full` includes bodies. */
  getThread(id: string, format: 'metadata' | 'full'): Promise<GmailThread> {
    const q = new URLSearchParams({ format });
    if (format === 'metadata') {
      for (const h of [
        'From',
        'To',
        'Reply-To',
        'Subject',
        'Date',
        'Message-ID',
        'References',
        'List-Unsubscribe',
        'List-Id',
        'Precedence',
        'Auto-Submitted',
      ]) {
        q.append('metadataHeaders', h);
      }
    }
    return this.s.request<GmailThread>(`${GMAIL}/threads/${encodeURIComponent(id)}?${q}`);
  }

  createDraft(raw: string, threadId: string) {
    return this.s.request<{ id: string; message: { id: string } }>(`${GMAIL}/drafts`, {
      method: 'POST',
      body: JSON.stringify({ message: { raw, threadId } }),
    });
  }

  updateDraft(id: string, raw: string, threadId: string) {
    return this.s.request<{ id: string; message: { id: string } }>(
      `${GMAIL}/drafts/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify({ message: { raw, threadId } }) },
    );
  }

  getDraft(id: string) {
    return this.s.request<{ id: string; message: GmailMessage }>(
      `${GMAIL}/drafts/${encodeURIComponent(id)}?format=full`,
    );
  }

  sendDraft(id: string) {
    return this.s.request<GmailMessage>(`${GMAIL}/drafts/send`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  }
}

/* ------------------------------ Calendar ----------------------------- */

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

export class CalendarClient {
  constructor(private readonly s: GoogleSession) {}

  async timeZone(): Promise<string | undefined> {
    const res = await this.s.request<{ timeZone?: string }>(`${CALENDAR}/calendars/primary`);
    return res.timeZone;
  }

  async busy(timeMin: Date, timeMax: Date): Promise<Array<{ start: number; end: number }>> {
    const res = await this.s.request<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }>(`${CALENDAR}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: 'primary' }],
      }),
    });
    return (res.calendars?.primary?.busy ?? []).map((b) => ({
      start: Date.parse(b.start),
      end: Date.parse(b.end),
    }));
  }

  /**
   * Inserts an event on the primary calendar under a fixed id, so a repeat returns the
   * existing event instead of a second one. Nobody is invited: no attendees, no emails.
   */
  async insertEvent(event: NewCalendarEvent): Promise<{ id: string; htmlLink?: string }> {
    const url = `${CALENDAR}/calendars/primary/events`;
    try {
      return await this.s.request<{ id: string; htmlLink?: string }>(`${url}?sendUpdates=none`, {
        method: 'POST',
        body: JSON.stringify({
          id: event.id,
          summary: event.title,
          location: event.location,
          description: event.description,
          start: { dateTime: event.start, timeZone: event.timeZone },
          end: { dateTime: event.end, timeZone: event.timeZone },
        }),
      });
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 409)) throw err;
      return this.s.request<{ id: string; htmlLink?: string }>(
        `${url}/${encodeURIComponent(event.id)}`,
      );
    }
  }
}

export interface NewCalendarEvent {
  /** 5–1024 characters from a–v and 0–9 (base32hex). */
  id: string;
  title: string;
  /** Local wall-clock times, `YYYY-MM-DDTHH:MM:SS`, in `timeZone`. */
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  description?: string;
}
