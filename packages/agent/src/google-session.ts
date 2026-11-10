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
      "Load the user's saved Google session into this cloud browser. Use it only when the task or the user asks for the saved Google session by name: by default a Google sign-in is not done in the cloud browser, and a site that needs one moves to the user's Mac with request_device. After loading, click the site's Google button again (or reload the page).",
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
              note: "No Google session is saved. A Google sign-in does not work in this cloud browser: call request_device to continue on the user's Mac.",
            },
      };
    },
  }) as ToolDef;
}
