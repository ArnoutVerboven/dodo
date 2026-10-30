import { scopesForTask } from '@dodo/budget';
import {
  BROWSER_ROUTER_SYSTEM,
  browserRouterTurn,
  type Device,
  type DeviceChoice,
  deviceChoice,
  isDeviceOnline,
} from '@dodo/core';
import { type GatewayDeps, generateWithBudget } from './gateway.js';

/**
 * Where a run goes and whether it gets a browser, for the `auto` settings. Device routing is
 * deterministic; the browser question goes to the cheapest model once per new task, and the
 * agent can still step up with request_browser when it finds out it needs one.
 */

export interface DeviceRoute {
  device: string;
  /** Why, in a few words, for the task's status line. */
  reason: string;
}

/**
 * Device `auto`: your Mac whenever one is online. Otherwise remote, unless the task names a
 * folder, which only a Mac has; then the Mac seen most recently, and the run waits for it.
 */
export function routeDevice(
  choice: DeviceChoice,
  folder: string | undefined,
  devices: Device[],
  now = Date.now(),
): DeviceRoute {
  if (choice !== 'auto') {
    return {
      device: choice,
      reason: choice === 'gcp' ? 'remote' : nameOf(devices, choice),
    };
  }
  const approved = devices
    .filter((d) => d.state === 'approved')
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const online = approved.find((d) => isDeviceOnline(d.lastSeen, now));
  if (online) return { device: deviceChoice(online.id), reason: `${online.name} is online` };
  const folderMac = folder ? approved[0] : undefined;
  if (folderMac) {
    return {
      device: deviceChoice(folderMac.id),
      reason: `folder ${folder} is on ${folderMac.name}`,
    };
  }
  return { device: 'gcp', reason: folder ? 'remote (no Mac paired)' : 'remote (no Mac online)' };
}

/**
 * The Mac a run moves to when the agent asks for one (request_device): the approved Mac seen
 * most recently, online or not; the run waits for it. Undefined when none is paired.
 */
export function routeToMac(
  devices: Device[],
  why: (name: string) => string = (name) => `moved to ${name} by the agent`,
): DeviceRoute | undefined {
  const mac = devices
    .filter((d) => d.state === 'approved')
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
  return mac ? { device: deviceChoice(mac.id), reason: why(mac.name) } : undefined;
}

/**
 * The local model runs only on a Mac: the Mac the task names, else the approved one seen most
 * recently (the run waits for it). Undefined when none is paired; the run then goes wherever
 * the usual routing says and ends with a message saying why.
 */
export function routeLocalModel(choice: DeviceChoice, devices: Device[]): DeviceRoute | undefined {
  if (choice.startsWith('mac:')) {
    return { device: choice, reason: `${nameOf(devices, choice)}, local model` };
  }
  return routeToMac(devices, (name) => `${name}, local model`);
}

function nameOf(devices: Device[], choice: string): string {
  return devices.find((d) => deviceChoice(d.id) === choice)?.name ?? choice;
}

const ROUTER_MODEL = 'gemini-3.1-flash-lite';

/**
 * Browser `auto`, asked once when a task starts: does the work need a real browser (a site to
 * log in to, click through or fill in, a JavaScript app, something to look at), or does
 * reading pages over HTTP, files, code and text cover it? Charged to the task; on any failure
 * the answer is no, and the agent asks for one later if it must.
 */
export async function needsBrowser(
  deps: GatewayDeps,
  task: { id: string; projectId?: string; title: string; description: string },
): Promise<boolean> {
  const res = await generateWithBudget(
    deps,
    {
      scopes: scopesForTask(task.id, task.projectId, Date.now()),
      taskId: task.id,
      projectId: task.projectId,
      description: 'browser routing',
    },
    {
      model: ROUTER_MODEL,
      systemInstruction: BROWSER_ROUTER_SYSTEM,
      contents: [
        {
          role: 'user',
          parts: [{ text: browserRouterTurn(task.title, task.description.slice(0, 4000)) }],
        },
      ],
      maxOutputTokens: 8,
      thinkingBudget: 0,
      temperature: 0,
    },
  );
  const text = res.content.parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
    .toLowerCase();
  return /^yes\b/.test(text);
}
