# dodo — Jobs

Jobs are small pipelines that watch a source (Gmail, WhatsApp, Calendar) on a schedule, decide with one short agent step whether something needs you, and push a task onto the board through the task ingest API. A task from a job links back to its thread and can carry a drafted reply that is only sent after you approve it.

Jobs are a separate feature: their own tab, their own Firestore collections, their own package (`packages/jobs`) and their own service account. They talk to the task app only through the ingest API (§6.5 of [ARCHITECTURE.md](ARCHITECTURE.md)), and reuse the shared control-plane pieces: the CostGate and model gateway, Telegram and web push notifications, and approval cards.

---

## 1. Shape

```txt
Cloud Scheduler (every 15 min) ─► jobsTick ─► for each enabled job that is due
                                               │  lock (lease) per job
                                               ▼
                         source scan (Gmail inbox, WhatsApp via Mac, …)
                                               │  cheap filters, no model
                                               ▼
                         idempotency ledger: jobs/{id}/items/{messageId}
                                               │  only new, unanswered messages
                                               ▼
                         agent step (gateway, job budget, ≤ 5 model calls)
                           tools: find_free_slots, search_tasks, decide
                                               │
                     ignore ◄──────────────────┼──────────────► create / update task
                                               │                 (ingest API, source logo,
                                               ▼                  link to thread)
                         reply draft in Gmail + approval card on the task
                                               │  Approve (web or Telegram Yes)
                                               ▼
                         jobsOnTaskMessage sends the draft, once
```

| Piece                             | Where                             | Does                                                                  |
| --------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `packages/jobs`                   | pure logic, dependencies injected | job runner, guardrails, Gmail/Calendar REST clients, prompts, MIME    |
| `apps/functions/src/jobs.ts`      | wiring only                       | `jobsTick` (schedule), `jobsRunNow`, Google OAuth, reply approvals    |
| `apps/functions/src/ingest.ts`    | the task ingest API               | `POST /v1/tasks` with per-source tokens; Jobs call the same core      |
| `apps/web/src/pages/JobsPage.tsx` | the Jobs tab                      | connect Google, enable jobs, settings, run now / dry run, recent runs |

## 2. Guardrails

- **Once per message.** Before a message is looked at, a ledger document `jobs/{jobId}/items/{messageId}` is created in a transaction. If it exists the message is skipped, whatever happened to it before. A failed item is retried at most twice, then left alone. A thread that gets a _new_ message gets a new item, which updates the existing task instead of making a second one.
- **Inbox only.** The Gmail query is `in:inbox` (Primary category by default), and each thread is checked again before use: the last message must carry the `INBOX` label and not `TRASH`, `SPAM` or `DRAFT`. Archived, deleted, snoozed and foldered mail is never read.
- **Unanswered only.** A thread counts when its last message is not from you and is older than the job's threshold (default 1 hour) and newer than its lookback (default 3 days, so turning a job on does not process years of mail).
- **Cheap filters first.** Mailing lists and automated mail (`List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, `noreply@`) are skipped without a model call.
- **Bounded runs.** Per run: at most 10 items, at most 5 model calls per item, and no new item after 4 minutes. Per job: a monthly budget (default 1 EUR) through the CostGate, which also respects the global caps and the kill switch, and at most 20 new tasks per day. One run per job at a time (a lease on the job document).
- **No loops.** Job tasks are created with AI off and the `untrusted` profile, so a job never starts agent runs. Sending a reply makes you the last sender, which ends the thread's "unanswered" state. Revisions of a draft are capped at 5 per message. Three failed runs in a row pause the job, and an expired Google sign-in pauses every Google job until you reconnect.
- **Untrusted content.** Email text is quoted, never followed: the agent step has only read-only tools, and anything that leaves dodo (sending a reply) needs your explicit approval with the exact draft shown.
- **Dry run.** "Dry run" shows what a job would do (decisions, titles, drafts) without creating tasks or drafts and without marking messages as done.

## 3. Reply approvals

When the agent step decides a reply is needed, the job creates a real **Gmail draft** in the thread and posts an approval card on the task with the draft quoted.

- **Approve** (web) or **Yes** (Telegram) sends the draft as it is in Gmail at that moment, so you can also edit it in Gmail first.
- **Deny** or **No** keeps the draft in Gmail and does nothing else.
- **Deny with a reason** ("propose Thursday instead") rewrites the draft with that instruction and posts a new card.
- Sending happens once: the card's state moves `pending → sending → sent` in a transaction before the Gmail call.
- If you reply in Gmail yourself, the next run sees it and marks the task done.

## 4. Connectors

### Gmail and Google Calendar (OAuth, built first)

One Google OAuth client for both. "Connect Google" in the Jobs tab runs the standard web flow; the callback function stores the refresh token in Secret Manager (`dodo-google-token`, readable only by the `dodo-jobs` account) and shows the connected address in the tab.

| Scope               | Why                                                          |
| ------------------- | ------------------------------------------------------------ |
| `gmail.readonly`    | read inbox threads                                           |
| `gmail.compose`     | create, update and send drafts (replies only after approval) |
| `calendar.readonly` | free/busy and time zone, to propose slots                    |
| `openid email`      | show which account is connected                              |

No `gmail.modify`: jobs never archive, label or delete mail. The app stays unverified for personal use; publishing the consent screen "In production" avoids the 7-day refresh-token expiry of testing mode.

### WhatsApp (harder, needs a decision)

There is no official API for a personal WhatsApp account. The options:

| Option                                       | How                                                                                                                   | Can read                 | Can send                                                          | Risk                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| **A. Mac, local database (recommended)**     | The dodo daemon reads WhatsApp Desktop's local `ChatStorage.sqlite` read-only and reports unanswered chats to the job | yes, while the Mac is on | prefilled draft through a `whatsapp://send` link: you press Enter | none for the account; depends on the app's file layout    |
| B. Linked device (Baileys / whatsapp-web.js) | An unofficial client linked by QR code, on the Mac or a small VM                                                      | yes, always              | yes, after approval                                               | against WhatsApp's terms; accounts can get banned         |
| C. WhatsApp Business Cloud API               | Official API                                                                                                          | only a business number   | yes                                                               | needs moving to a business number; not for personal chats |

### Task ingest API

`POST /v1/tasks` (and `GET /v1/tasks`, `POST /v1/tasks/{id}/messages`) on the `taskApi` function, with a bearer token per source created in Settings. Jobs use the same core in-process. Tasks carry a `source` (`gmail`, `whatsapp`, `api`, …) with a link to the original, shown as a logo on the board and a "Open in Gmail" link on the task.

## 5. More jobs worth having

1. **Waiting for a reply**: mail you sent with a question that got no answer in 3 days becomes "Follow up with X", with a polite nudge drafted.
2. **Bills and invoices**: an invoice in the inbox becomes "Pay <supplier> €X" with the due date, amount and IBAN pulled out.
3. **Unanswered invites**: calendar invitations without an RSVP become a task with Accept / Decline as the approval.
4. **Meeting prep**: each evening, tomorrow's meetings with external people get a short prep task (who, last thread with them, open items).
5. **Bookings to calendar**: flight, train and restaurant confirmations become calendar events after approval.
6. **Weekly sweep**: open job tasks whose thread went quiet for 2 weeks are listed once a week for "close or keep".
