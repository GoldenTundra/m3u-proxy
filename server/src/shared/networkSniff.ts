import { launchBrowser } from './launchBrowser'

const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|webm)(\?|$)/i
const EMBEDDED_URL_RE = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>]*)?/i
const LOAD_TIMEOUT_MS = 5000
const SNIFF_WINDOW_MS = 5000

function rank(url: string): number {
  // Prefer manifests over raw media segments.
  if (/\.m3u8(\?|$)/i.test(url)) return 3
  if (/\.mpd(\?|$)/i.test(url)) return 3
  if (/\.mp4(\?|$)/i.test(url)) return 2
  if (/\.webm(\?|$)/i.test(url)) return 2
  return 1
}

export async function sniffNetworkForMedia(url: string): Promise<string | undefined> {
  const browser = await launchBrowser()
  const counts = new Map<string, number>()

  try {
    const page = await browser.newPage()
    page.on('request', (req) => {
      const reqUrl = req.url()
      if (MEDIA_URL_RE.test(reqUrl)) counts.set(reqUrl, (counts.get(reqUrl) ?? 0) + 1)
    })
    // Some sites resolve their stream indirectly: the page calls a small
    // JSON/text API that returns the real manifest URL in its body, rather
    // than the browser ever requesting a URL matching our extension pattern
    // directly. Scan small text-ish response bodies for an embedded one.
    page.on('response', (res) => {
      const contentType = res.headers()['content-type'] ?? ''
      if (!/json|text/i.test(contentType)) return
      res
        .text()
        .then((body) => {
          const match = body.match(EMBEDDED_URL_RE)
          if (match) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
        })
        .catch(() => undefined)
    })

    await Promise.race([
      page.goto(url, { timeout: LOAD_TIMEOUT_MS }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))
    ])
    // Give the page time to kick off manifest/segment requests after load.
    await new Promise((resolve) => setTimeout(resolve, SNIFF_WINDOW_MS))
  } finally {
    await browser.close()
  }

  if (counts.size === 0) return undefined
  // A real live player re-polls its manifest repeatedly; one-off ad/filler
  // requests (which can otherwise match the same URL pattern, e.g. an ad
  // server using a public demo HLS stream as blank filler) are typically
  // fetched only once. Prefer whichever URL was actually re-fetched.
  return [...counts.entries()].sort(
    ([urlA, countA], [urlB, countB]) => countB - countA || rank(urlB) - rank(urlA)
  )[0][0]
}
