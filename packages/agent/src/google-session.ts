import { GOOGLE_SESSION_PROMPT, GOOGLE_SESSION_RULE } from '@dodo/core';
import { z } from 'zod';
import { define, type ToolDef } from './tools.js';

/**
 * The user's shared Google session for the remote browser (ARCHITECTURE §9.1). A task starts
 * without it; the agent switches it on when a page wants a Google sign-in ("Continue with
 * Google", accounts.google.com). The worker then loads Google's cookies into the task's
 * browser and, when the run ends, saves Google's cookies back, so the one sign-in the user
 * confirmed on their phone serves every later task until Google ends it.
 */
export interface GoogleSessionAccess {
  /** Loads the saved session into the browser; false when there is none yet. */
  load(): Promise<boolean>;
}

export function googleSessionTool(access: GoogleSessionAccess): ToolDef {
  let loaded: boolean | undefined;
  return define({
    name: 'use_google_session',
    description:
      "Switch this browser to the user's own Google account, when a site offers 'Continue with Google' / 'Sign in with Google' or a Google sign-in page appears. Loads their saved Google session, so the Google step goes through without a password; then click the Google button again (or reload the page). When no session is saved yet, sign in once on accounts.google.com with the Google entry from the vault and ask the user to confirm on their phone; that sign-in is saved for later tasks.",
    schema: z.object({
      reason: z.string().min(1).max(300).describe('Which site wants the Google sign-in.'),
    }),
    policy: () => ({ tool: 'GoogleSession', key: 'use', category: 'sandbox' }),
    async execute({ reason }) {
      if (loaded === undefined) {
        try {
          loaded = await access.load();
        } catch (err) {
          const message = (err as Error).message;
          // Each task asks you once; the control plane only hands the session to a task you
          // approved.
          if (/not approved/i.test(message))
            return {
              result: {
                ok: true,
                note: 'The run pauses here until the user answers; then call use_google_session again.',
              },
              askUser: {
                kind: 'approval',
                prompt: `${GOOGLE_SESSION_PROMPT} ${reason}`,
                suggestedRule: GOOGLE_SESSION_RULE,
              },
            };
          return { result: { error: `Google session not available: ${message}` } };
        }
      }
      return {
        result: loaded
          ? {
              ok: true,
              note: "The user's Google session is loaded in this browser. Click the Google sign-in button again or reload the page; pick the user's account if Google asks which one.",
            }
          : {
              ok: true,
              note: "No Google session is saved yet. Sign in on the Google page now: the email and password from the user's Google vault entry (list_vault, request_vault_access), then ask_user with a screenshot to confirm on their phone if Google asks. When this run ends the Google sign-in is saved for later tasks.",
            },
      };
    },
  }) as ToolDef;
}
