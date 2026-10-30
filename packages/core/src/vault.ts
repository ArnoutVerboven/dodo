import { z } from 'zod';
import { Timestamp } from './model.js';

/**
 * The agent vault (ARCHITECTURE §9.2): logins and other values the agent may type into a site
 * without the model ever seeing them. Values live in Secret Manager and only the control plane
 * reads them; Firestore holds what is safe to show (names, sites, field names).
 */

export const VaultId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes');
export const VaultFieldKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'lowercase letters, digits, dashes and underscores');

/** A site the entry may be used on: `engie.be` also covers `www.engie.be`, never `engie.be.evil.com`. */
export const VaultDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'a host name like engie.be');

export const VaultField = z.object({ key: VaultFieldKey, label: z.string().min(1).max(80) });
export type VaultField = z.infer<typeof VaultField>;

/** What everyone (the web app, the model) may see about an entry. Never a value. */
export const VaultEntry = z.object({
  id: VaultId,
  name: z.string().min(1).max(100),
  domains: z.array(VaultDomain).min(1).max(10),
  fields: z.array(VaultField).max(10),
  /** Not secret: how to log in, e.g. "Log in with itsme, phone number in the phone field". */
  hint: z.string().max(500).default(''),
  lastUsed: z.object({ at: Timestamp, taskId: z.string(), field: z.string() }).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VaultEntry = z.infer<typeof VaultEntry>;

/** Settings › Vault: create or change an entry. A field without a value keeps its stored value. */
export const VaultSaveRequest = z.object({
  id: VaultId,
  name: z.string().trim().min(1).max(100),
  domains: z.array(VaultDomain).min(1).max(10),
  hint: z.string().max(500).default(''),
  fields: z
    .array(VaultField.extend({ value: z.string().max(4000).optional() }))
    .max(10)
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'field keys must be unique'),
});
export type VaultSaveRequest = z.input<typeof VaultSaveRequest>;

export const VaultDeleteRequest = z.object({ id: VaultId });

/** A browser tool asks for one value, for the site it is about to type it into. */
export const VaultResolveRequest = z.object({
  runId: z.string(),
  entryId: VaultId,
  field: VaultFieldKey,
  host: z.string().min(1).max(253),
});
export type VaultResolveRequest = z.infer<typeof VaultResolveRequest>;

/** The permission rule for using an entry in a task: `Vault(energy)`. */
export const vaultRule = (entryId: string) => `Vault(${entryId})`;

/** The entry id in a `Vault(<id>)` rule. */
export const vaultRuleEntry = (rule: string | undefined): string | undefined =>
  /^Vault\(([a-z0-9][a-z0-9-]{0,39})\)$/.exec(rule ?? '')?.[1];

/**
 * How an approval card for an entry starts, written from the entry itself (the control plane
 * checks it): what you say yes to is this entry, on these sites, whatever the agent adds.
 */
export const vaultApprovalPrompt = (entry: Pick<VaultEntry, 'name' | 'domains' | 'fields'>) =>
  `Use your vault entry "${entry.name}" (${entry.fields.map((f) => f.label.toLowerCase()).join(', ')}) on ${entry.domains.join(', ')} for this task?`;

/** How the model refers to a value: `{{vault:energy.password}}`. */
export const vaultRef = (entryId: string, field: string) => `{{vault:${entryId}.${field}}}`;
const REF = /\{\{vault:([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9_-]*)\}\}/g;

/** Every vault reference in a text, in order, without duplicates. */
export function vaultRefs(text: string): Array<{ entryId: string; field: string; ref: string }> {
  const seen = new Set<string>();
  const out: Array<{ entryId: string; field: string; ref: string }> = [];
  for (const m of text.matchAll(REF)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ entryId: m[1] as string, field: m[2] as string, ref: m[0] });
  }
  return out;
}

/**
 * A secret answer to ask_user (an MFA code): the user's value is kept server-side and the
 * conversation only carries `{{answer:<messageId>}}`, which a browser tool types like a vault
 * reference.
 */
export const answerRef = (messageId: string) => `{{answer:${messageId}}}`;
const ANSWER_REF = /\{\{answer:([A-Za-z0-9_-]{1,64})\}\}/g;

/** Every secret-answer reference in a text, in order, without duplicates. */
export function answerRefs(text: string): Array<{ messageId: string; ref: string }> {
  const seen = new Set<string>();
  const out: Array<{ messageId: string; ref: string }> = [];
  for (const m of text.matchAll(ANSWER_REF)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ messageId: m[1] as string, ref: m[0] });
  }
  return out;
}

/** The message id when a value is exactly one secret-answer reference. */
export function secretAnswerId(value: string): string | undefined {
  const refs = answerRefs(value);
  return refs.length === 1 && refs[0]?.ref === value.trim() ? refs[0].messageId : undefined;
}

/** Whether a text holds anything a browser tool must resolve before typing it. */
export const hasSecretRefs = (text: string) =>
  vaultRefs(text).length > 0 || answerRefs(text).length > 0;

/** The owner answers a secret question (app or Telegram); the value never enters the thread. */
export const SecretAnswerRequest = z.object({
  taskId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(64),
  value: z.string().min(1).max(200),
});
export type SecretAnswerRequest = z.infer<typeof SecretAnswerRequest>;

/** A run's browser tool gets the value of a secret answer on its task. */
export const AnswerResolveRequest = z.object({
  runId: z.string(),
  messageId: z.string().min(1).max(64),
});
export type AnswerResolveRequest = z.infer<typeof AnswerResolveRequest>;

/** Same reading of an approval answer as the loop and the budget top-up. */
export const isApproved = (answer: string) =>
  /^(y|yes|yeah|yep|ok|okay|approve|approved|allow|allowed)\b/i.test(answer.trim());

/**
 * Things about you the agent may use freely (forms, sign-ups, scheduling): not secret, so it is
 * in the model's context when the agent asks for it. Passwords and ID numbers go in the vault.
 */
export const PersonalInfo = z.object({
  fullName: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  address: z
    .object({
      street: z.string().max(200).optional(),
      postalCode: z.string().max(20).optional(),
      city: z.string().max(100).optional(),
      country: z.string().max(100).optional(),
    })
    .optional(),
  birthDate: z.string().max(20).optional(),
  language: z.string().max(50).optional(),
  timeZone: z.string().max(60).optional(),
  /** Anything else, e.g. "Company: Acme", "Bike size: L". */
  extra: z
    .array(z.object({ label: z.string().min(1).max(80), value: z.string().max(1000) }))
    .max(30)
    .default([]),
  /** Free-form context about you for the agent. */
  notes: z.string().max(4000).optional(),
  /** When you are available; read by Jobs when proposing meeting times. */
  schedulingNotes: z.string().max(2000).optional(),
  updatedAt: Timestamp.optional(),
});
export type PersonalInfo = z.infer<typeof PersonalInfo>;
