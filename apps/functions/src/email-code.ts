import { type EmailCodeRequest, type EmailCodeResponse, type Run, siteOf } from '@dodo/core';
import { findEmailCode, type GmailClient, GoogleAuthError } from '@dodo/jobs';

/**
 * A run's emailed one-time code (ARCHITECTURE §9.3): the newest mail from the site the run's
 * page is on, read from the Gmail account connected for Jobs. The code goes back to the run's
 * browser tool only, which types it into that site's page and keeps it out of the model's
 * context; this side logs which mail, never the code.
 */
export interface EmailCodeDeps {
  /** Undefined when Google is not configured or connected. */
  gmail: () => Pick<GmailClient, 'listMessages' | 'getMessage'> | undefined;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

/** No older mail than this, whatever the run asks. */
const MAX_LOOKBACK_MS = 30 * 60_000;

export async function emailCodeForRun(
  deps: EmailCodeDeps,
  run: Pick<Run, 'id' | 'taskId'>,
  req: EmailCodeRequest,
): Promise<EmailCodeResponse> {
  const gmail = deps.gmail();
  if (!gmail)
    return {
      found: false,
      error: 'Gmail is not connected: connect Google in dodo (Jobs › Connect Google) first.',
    };
  const now = (deps.now ?? Date.now)();
  const site = siteOf(req.sender ?? req.host);
  try {
    const found = await findEmailCode(gmail, {
      site,
      since: Math.max(req.since, now - MAX_LOOKBACK_MS),
      exclude: req.exclude,
    });
    if (!found) return { found: false };
    deps.log?.('email code found', {
      runId: run.id,
      taskId: run.taskId,
      site,
      host: req.host,
      gmailId: found.id,
    });
    return { found: true, ...found };
  } catch (err) {
    if (err instanceof GoogleAuthError)
      return {
        found: false,
        error: `Gmail is not reachable (${err.message}); connect Google again in dodo.`,
      };
    throw err;
  }
}
