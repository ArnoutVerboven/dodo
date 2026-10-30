import {
  AGENT_BROWSER_WINDOW,
  AGENT_HEADLESS_NO_HOLD,
  AGENT_REQUEST_BROWSER,
  AGENT_SYSTEM,
  agentBrowserHeadless,
  agentHeadlessHold,
  agentProject,
  agentRepository,
  PHONE_APP_LOGIN,
  type Project,
  type Task,
} from '@dodo/core';

/** The texts live in @dodo/core's prompts module; this assembles them for one run. */

export interface PromptFeatures {
  /** The run has browser tools: a Chrome window on the user's Mac, or headless Chromium remotely. */
  browser?: 'window' | 'headless';
  /** Headless: how long the page stays open while a question waits for the user. */
  holdMinutes?: number;
  /** No browser now, but request_browser can get one. */
  canRequestBrowser?: boolean;
  github?: string;
}

export function systemPrompt(
  _task: Task,
  project: Project | undefined,
  features: PromptFeatures = {},
): string {
  const lines = [AGENT_SYSTEM];
  if (features.browser === 'window') {
    lines.push('', AGENT_BROWSER_WINDOW, PHONE_APP_LOGIN);
  } else if (features.browser === 'headless') {
    const hold = features.holdMinutes
      ? agentHeadlessHold(features.holdMinutes)
      : AGENT_HEADLESS_NO_HOLD;
    lines.push('', agentBrowserHeadless(hold), PHONE_APP_LOGIN);
  }
  if (features.canRequestBrowser) lines.push('', AGENT_REQUEST_BROWSER);
  if (features.github) lines.push('', agentRepository(features.github));
  if (project) {
    lines.push('', agentProject(project.name, project.description, project.instructions));
  }
  return lines.join('\n');
}

export function taskContext(
  task: Task,
  messages: Array<{ author: string; body: string; createdAt: number }>,
  artifacts: Array<{ id: string; kind: string; name: string; url?: string }>,
): string {
  const parts = [
    `# Task: ${task.title}`,
    task.description.trim() ? task.description.trim() : '(no description)',
  ];
  if (task.tags.length) parts.push(`Tags: ${task.tags.join(', ')}`);
  if (task.priority !== 'none') parts.push(`Priority: ${task.priority}`);
  if (task.dueDate) parts.push(`Due: ${task.dueDate}`);
  if (task.summary.trim())
    parts.push('', '## Current summary (from earlier work)', task.summary.trim());
  if (artifacts.length) {
    parts.push('', '## Artifacts');
    for (const a of artifacts)
      parts.push(`- [${a.kind}] ${a.name} (id ${a.id})${a.url ? ` ${a.url}` : ''}`);
  }
  if (messages.length) {
    parts.push('', '## Thread (oldest first)');
    for (const m of messages) parts.push(`${m.author}: ${m.body}`);
  }
  return parts.join('\n');
}
