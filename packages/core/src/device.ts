import { z } from 'zod';

/**
 * Control-plane API for the Mac daemon. The daemon signs in as `device:{id}` and may only
 * claim runs addressed to it; each claimed run gets the same per-run identity a cloud run gets.
 */

/** Bumped when the daemon and the control plane stop understanding each other. */
export const DEVICE_PROTOCOL = 1;
/** Mac runs have no container cost, so they get a fixed cap instead of a budget-derived one. */
export const DEVICE_RUN_TIMEOUT_S = 3600;
/** The daemon writes `lastSeen` this often; the UI shows offline after three missed beats. */
export const DEVICE_HEARTBEAT_MS = 30_000;

export const DeviceRegisterRequest = z.object({
  code: z.string().min(6).max(40),
  name: z.string().trim().min(1).max(60),
  platform: z.string().max(20).default('darwin'),
  version: z.string().max(40).optional(),
  protocol: z.number().int().nonnegative(),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequest>;

export const DeviceRegisterResponse = z.object({
  deviceId: z.string(),
  /** Custom token for the device identity; the daemon signs in with it once and keeps the refresh token. */
  token: z.string(),
  /** Client config for the daemon's Firebase SDKs; absent on the emulator (demo key). */
  firebase: z.object({ apiKey: z.string(), projectId: z.string() }).optional(),
});
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponse>;

export const DeviceClaimRequest = z.object({
  deviceId: z.string(),
  runId: z.string(),
  protocol: z.number().int().nonnegative(),
  version: z.string().max(40).optional(),
});
export type DeviceClaimRequest = z.infer<typeof DeviceClaimRequest>;

export const DeviceClaimResponse = z.object({
  /** Custom token for the run identity, exactly what the dispatcher gives Cloud Run. */
  token: z.string(),
  taskId: z.string(),
  generation: z.number().int(),
  timeoutSeconds: z.number().int(),
});
export type DeviceClaimResponse = z.infer<typeof DeviceClaimResponse>;

export const deviceUid = (deviceId: string) => `device:${deviceId}`;
/** The `device` value a run carries when it is routed to a Mac. */
export const deviceChoice = (deviceId: string) => `mac:${deviceId}`;
export const deviceIdFromChoice = (choice: string): string | undefined =>
  choice.startsWith('mac:') ? choice.slice(4) : undefined;

export const isDeviceOnline = (lastSeen: number | undefined, now = Date.now()) =>
  lastSeen !== undefined && now - lastSeen < 3 * DEVICE_HEARTBEAT_MS;

/**
 * The sandbox around a Mac run asks before it lets the run reach a host no rule covers. The
 * answer comes from the same policy the agent's tools are judged by, applied by trusted code.
 */
export const DeviceEgressRequest = z.object({
  deviceId: z.string(),
  runId: z.string(),
  host: z.string().min(1).max(253),
  port: z.number().int().positive().max(65535).optional(),
});
export type DeviceEgressRequest = z.infer<typeof DeviceEgressRequest>;

export const DeviceEgressResponse = z.object({
  allow: z.boolean(),
  /** The rule or setting that decided, for the daemon's log. */
  by: z.string().optional(),
});
export type DeviceEgressResponse = z.infer<typeof DeviceEgressResponse>;

/** The daemon's worker exited without finishing its run: let the run end as failed now. */
export const DeviceReleaseRequest = z.object({
  deviceId: z.string(),
  runId: z.string(),
  exitCode: z.number().int().nullable(),
});
export type DeviceReleaseRequest = z.infer<typeof DeviceReleaseRequest>;
