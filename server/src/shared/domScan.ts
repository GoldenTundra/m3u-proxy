import { launchBrowser } from './launchBrowser'
import { pollPage } from './pollPage'

const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|webm)(\?|$)/i
// Poll rather than check once — see pollPage.ts (JS-challenge redirects).
const POLL_TIMEOUT_MS = 8000

export async function scanDomForVideo(url: string): Promise<string | undefined> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined)
    return await pollPage(page, POLL_TIMEOUT_MS, () =>
      page.evaluate((re: { source: string; flags: string }) => {
        const pattern = new RegExp(re.source, re.flags)
        const els = Array.from(document.querySelectorAll('video, source'))
        for (const el of els) {
          const candidate =
            (el as HTMLVideoElement).currentSrc || el.getAttribute('src') || undefined
          if (candidate && pattern.test(candidate)) return candidate
        }
        return null
      }, { source: MEDIA_URL_RE.source, flags: MEDIA_URL_RE.flags })
    )
  } catch {
    return undefined
  } finally {
    await browser.close()
  }
}
