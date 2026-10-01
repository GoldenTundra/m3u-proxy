// Some CDNs fingerprint the TLS/HTTP client itself and reject anything that
// isn't a real browser — confirmed against at least one live-sports CDN:
// replaying the exact headers a browser sent (Origin, Referer, User-Agent,
// sec-ch-ua, ...) via Node's fetch still gets a 403, but the identical
// request run from inside the page's own JS context succeeds. A plain Node
// proxy can never fetch these streams itself.
//
// Instead, keep a real headless browser open on the page and route fetches
// through it, two ways:
//  - Passively: watch the page's own player fetch manifests/segments and
//    cache the bytes, then serve our client's requests out of that cache.
//  - Actively: run fetch() inside the page's JS context (fetchText/
//    fetchBytes), which gets the real browser's TLS fingerprint. Needed
//    because the page's player often never plays at all: Playwright's
//    Chromium has no H.264/AAC (proprietary codecs), so e.g. a site's
//    JW Player fetches the master playlist, finds no playable format, and
//    stops — no variant or segment fetch ever happens to observe.
import type { Browser, Page, Response } from 'playwright'
import { launchBrowser } from './launchBrowser'

const PLAYLIST_URL_RE = /\.m3u8(\?|$)/i
const PLAYLIST_CONTENT_TYPE_RE = /mpegurl/i
const SEGMENT_URL_RE = /\.(ts|m4s|aac|mp4|cmfv|cmfa)(\?|$)/i
const MAX_CACHED_SEGMENTS = 60
const SEGMENT_WAIT_TIMEOUT_MS = 8000
const SEGMENT_WAIT_POLL_MS = 150

export interface CachedSegment {
  body: Buffer
  contentType: string
}

export class BrowserRelay {
  private browser: Browser | undefined
  private page: Page | undefined
  private segments = new Map<string, CachedSegment>()
  private latestPlaylist: { url: string; body: string } | undefined
  private closed = false

  private constructor() {}

  static async start(target: string): Promise<BrowserRelay> {
    const relay = new BrowserRelay()
    relay.browser = await launchBrowser()
    const page = await relay.browser.newPage()
    relay.page = page
    page.on('response', (res) => relay.handleResponse(res).catch(() => undefined))
    // Muted autoplay doesn't need a user gesture, which is what every one of
    // these embed players relies on (autostart + mute) — no interaction to
    // simulate here, just let the page run.
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined)
    return relay
  }

  private async handleResponse(res: Response): Promise<void> {
    if (this.closed || !res.ok()) return
    const url = res.url()
    const contentType = res.headers()['content-type'] ?? ''

    if (PLAYLIST_URL_RE.test(url) || PLAYLIST_CONTENT_TYPE_RE.test(contentType)) {
      const body = await res.text().catch(() => undefined)
      if (!body) return
      this.latestPlaylist = { url, body }
      return
    }

    if (!SEGMENT_URL_RE.test(url)) return
    const body = await res.body().catch(() => undefined)
    if (!body) return
    this.segments.set(url, { body, contentType })
    if (this.segments.size > MAX_CACHED_SEGMENTS) {
      const oldest = this.segments.keys().next().value
      if (oldest !== undefined) this.segments.delete(oldest)
    }
  }

  // We only ever track the single most recently observed playlist — some of
  // these sites rotate the manifest URL's signed token on every refresh, so
  // there's no fixed URL to look up by; "most recent playlist seen at all"
  // is the reliable signal. The caller needs the actual URL back too, to
  // resolve the manifest's relative segment URIs against the right base.
  getPlaylist(): { url: string; body: string } | undefined {
    return this.latestPlaylist
  }

  // In-page fetch, so the request carries the real browser's TLS/HTTP
  // fingerprint (and the page's Origin/Referer/cookies), which Node's fetch
  // can't reproduce. Throws on a non-OK status.
  async fetchText(url: string): Promise<string> {
    if (!this.page) throw new Error('Relay not started')
    const { status, body } = await this.page.evaluate(async (u) => {
      const r = await fetch(u)
      return { status: r.status, body: await r.text() }
    }, url)
    if (status < 200 || status >= 300) throw new Error(`Relay fetch returned ${status} for ${url}`)
    return body
  }

  async fetchBytes(url: string): Promise<CachedSegment> {
    if (!this.page) throw new Error('Relay not started')
    const { status, base64, contentType } = await this.page.evaluate(async (u) => {
      const r = await fetch(u)
      const blob = await r.blob()
      // FileReader's data URL is far faster than building a base64 string
      // by hand for multi-MB segments.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      return { status: r.status, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), contentType: r.headers.get('content-type') ?? '' }
    }, url)
    if (status < 200 || status >= 300) throw new Error(`Relay fetch returned ${status} for ${url}`)
    return { body: Buffer.from(base64, 'base64'), contentType }
  }

  // Non-blocking cache lookup, for callers with their own fallbacks.
  getCachedSegment(url: string): CachedSegment | undefined {
    return this.segments.get(url)
  }

  isClosed(): boolean {
    return this.closed
  }

  // The client's own request pace isn't synchronized with the headless
  // page's prefetching, so a brief wait-and-poll is normal, not an error.
  async getSegment(url: string): Promise<CachedSegment | undefined> {
    const deadline = Date.now() + SEGMENT_WAIT_TIMEOUT_MS
    for (;;) {
      const hit = this.segments.get(url)
      if (hit) return hit
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, SEGMENT_WAIT_POLL_MS))
    }
  }

  // Callers need to know the page's player actually started producing a
  // stream before handing the client a proxy URL to request — otherwise
  // its very first request would race an empty cache.
  async waitForPlaylist(timeoutMs: number): Promise<{ url: string; body: string } | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.latestPlaylist) return this.latestPlaylist
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, SEGMENT_WAIT_POLL_MS))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.page?.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
  }
}
