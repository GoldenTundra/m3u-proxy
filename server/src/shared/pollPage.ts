import type { Page } from 'playwright'

const POLL_INTERVAL_MS = 500
// How long the main frame must go without navigating before we give up.
// JS-challenge stubs (e.g. ones that set a cookie, then reload/redirect to a
// mirror domain) replace the page a few seconds after the initial
// domcontentloaded, so a single check right after goto() only ever
// sees the stub. But a page that's loaded and stayed put for this long
// isn't going to grow a player later, so don't burn the full timeout on it.
const QUIET_MS = 4000

// Repeatedly runs `check` until it returns a value, the main frame has been
// navigation-free for QUIET_MS, or `timeoutMs` elapses. `check` rejecting
// (e.g. "Execution context was destroyed" when the page navigates
// mid-evaluate) is treated as "not yet".
export async function pollPage<T>(
  page: Page,
  timeoutMs: number,
  check: () => Promise<T | null | undefined>
): Promise<T | undefined> {
  let lastMainNavAt = Date.now()
  const onNav = (frame: unknown) => {
    if (frame === page.mainFrame()) lastMainNavAt = Date.now()
  }
  page.on('framenavigated', onNav)
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && Date.now() - lastMainNavAt < QUIET_MS) {
      const result = await check().catch(() => null)
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return undefined
  } finally {
    page.off('framenavigated', onNav)
  }
}
