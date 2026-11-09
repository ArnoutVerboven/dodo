import { CLOUD_ARGS, type DriverOptions } from './drivers/types.ts';

/**
 * The cached approach (Stagehand's idea, without Stagehand): replay the Playwright code a
 * successful run executed, with no model at all. Playwright MCP prints that code with every
 * action, so dodo could store it per site after a good login and try it first next time.
 */
export async function replay(
  start: string,
  code: string[],
  opts: DriverOptions,
): Promise<{ url: string; text: string; error?: string }> {
  const { chromium } = await import('playwright');
  const launch = {
    headless: !opts.headed || Boolean(opts.cloud),
    chromiumSandbox: !opts.noSandbox,
    ...(opts.cloud ? { args: CLOUD_ARGS } : {}),
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
  };
  const browser =
    opts.executablePath || opts.cloud
      ? await chromium.launch(launch)
      : await chromium
          .launch({ ...launch, channel: 'chrome' })
          .catch(() => chromium.launch(launch));
  let error: string | undefined;
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      ...(opts.cloud ? { userAgent: opts.cloud.userAgent } : {}),
    });
    page.setDefaultTimeout(10_000);
    await page.goto(start);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (page: unknown) => Promise<void>;
    for (const step of code) {
      try {
        await new AsyncFunction('page', step)(page);
      } catch (e) {
        error = `step failed: ${step.split('\n')[0]}: ${(e as Error).message.split('\n')[0]}`;
        break;
      }
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // innerText, not textContent: the check should see what a person sees, not hidden text.
    // biome-ignore lint/performance/useDomNodeTextContent: visible text is the point
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    return { url: page.url(), text, error };
  } finally {
    await browser.close();
  }
}
