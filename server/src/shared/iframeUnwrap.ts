// Many stream-aggregator sites wrap the actual player in an <iframe>
// pointing at a separate embed domain.
// Resolving against the wrapper page's own URL captures the wrong page as
// the effective "source" (wrong Referer origin) — confirmed by testing the
// embedded page's URL directly, which resolves and plays fine. So: find the
// player iframe and treat its src as the real target.
import type { Page } from 'playwright'
import { launchBrowser } from './launchBrowser'
import { pollPage } from './pollPage'

// Poll rather than check once — see pollPage.ts (JS-challenge redirects).
const POLL_TIMEOUT_MS = 12000
// Give iframes a moment to actually render/size themselves before we
// pick the largest one as the likely player (vs small ad iframes).
const SETTLE_MS = 1000
// Ad/tracking/captcha iframes that ad-heavy pages load
// in bulk — some sized larger than the real player. Picking one sends the
// resolver on a slow dead end (~17s of DOM-scan + sniff inside an ad frame)
// before it falls back to the top-level page anyway.
const NON_PLAYER_HOST_RE =
  /(^|\.)(googlesyndication\.com|doubleclick\.net|adtrafficquality\.google|google\.com|taboola\.com|btloader\.com|rubiconproject\.com|pubmatic\.com|amazon-adsystem\.com|adnxs\.com|criteo\.com)$/i

async function largestIframeSrc(page: Page): Promise<string | undefined> {
  const src = await page
    .evaluate((skip: { source: string; flags: string }) => {
      const skipRe = new RegExp(skip.source, skip.flags)
      return (
        Array.from(document.querySelectorAll('iframe'))
          .map((el) => ({ src: (el as HTMLIFrameElement).src, area: el.offsetWidth * el.offsetHeight }))
          .filter((f) => f.src && f.src.startsWith('http') && !skipRe.test(new URL(f.src).hostname))
          .sort((a, b) => b.area - a.area)[0]?.src || null
      )
    }, { source: NON_PLAYER_HOST_RE.source, flags: NON_PLAYER_HOST_RE.flags })
  return src ?? undefined
}

export async function findPlayerIframeSrc(url: string): Promise<string | undefined> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined)
    if (!(await pollPage(page, POLL_TIMEOUT_MS, () => largestIframeSrc(page)))) return undefined
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    return await largestIframeSrc(page)
  } catch {
    return undefined
  } finally {
    await browser.close()
  }
}
