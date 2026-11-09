export {
  browserCookies,
  type CdpBridge,
  type ChromeLaunch,
  cdpCookies,
  launchChromeBridge,
  restoreState,
  type StorageState,
} from './cdp-bridge.js';
export {
  AgentBrowser,
  type AgentBrowserOptions,
  agentBrowserBinary,
  type CommandResult,
} from './cli.js';
export { type HttpMcp, mcpServer, serveHttp } from './server.js';
export { findInSnapshot, markFrames, toTarget } from './snapshot.js';
export {
  AgentBrowserTools,
  type AgentBrowserToolsOptions,
  TOOLS,
  type ToolResult,
} from './tools.js';

/** The engines dodo can drive a browser with. */
export const BROWSER_ENGINES = ['agent-browser', 'playwright'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
