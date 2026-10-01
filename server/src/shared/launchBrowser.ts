import { chromium, Browser } from 'playwright'

// Every resolve loads arbitrary, often ad-heavy pages, so run Chromium with
// its sandbox on when the host allows it. Playwright disables it by default;
// it needs a non-root user (see the Dockerfile) and permission to create
// user namespaces (docker-compose.yml's seccomp profile — some NAS/older or
// AppArmor-restricted kernels still refuse). So probe once at first launch
// and fall back to no sandbox for the rest of the process if it can't start.
let sandboxProbe: Promise<boolean> | undefined

function probeSandbox(): Promise<boolean> {
  sandboxProbe ??= chromium
    .launch({ headless: true, chromiumSandbox: true })
    .then(async (browser) => {
      await browser.close()
      console.log('[browser] Chromium sandbox enabled')
      return true
    })
    .catch((err) => {
      console.warn(
        '[browser] Chromium sandbox unavailable on this host; running without it. ' +
          `(${err instanceof Error ? err.message.split('\n')[0] : err})`
      )
      return false
    })
  return sandboxProbe
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, chromiumSandbox: await probeSandbox() })
}
