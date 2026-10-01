import { PUBLIC_BASE_URL } from '../config'
import { resolve } from '../shared/resolver'
import type { ResolvedStream } from '../shared/types/stream'
import { BrowserRelay } from '../shared/browserRelay'
import { createSession } from '../sessions/sessionStore'
import { listFavorites } from '../favorites/favoritesStore'
import { requestGuideRefresh } from './channelsDvr'
import { activeEvents, endsAt, eventKey, listEvents, sweepFinishedEvents, LiveEvent } from '../events/eventStore'

// Anything that can be warmed: a favorite (keyed by its title) or a live
// event (keyed by eventKey()). Favorite satisfies this as-is.
export interface WarmSource {
  title: string
  url: string
}

const VERIFY_TIMEOUT_MS = 5000
const RELAY_STARTUP_TIMEOUT_MS = 15000
// Channels DVR's tuner times out waiting for response headers long before a
// cold resolve() finishes (~20s observed for one aggregator site, and that's
// without needing the browser-relay fallback) — so channels are resolved
// ahead of time in the background and /channel/:title just hands back
// whatever's already warm. 30 minutes keeps sessions inside typical
// signed-URL expiry windows without re-resolving (and, for relay-backed
// channels, relaunching a real browser) more often than needed.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000
// Each resolve launches headless Chromium on ad-heavy pages (~300-500MB
// each), and small home servers often have only a few GB to spare — so
// warm a few at a time, not all at once. Enough that one
// slow/dead site doesn't hold up the rest of the favorites.
const WARM_CONCURRENCY = 3

interface WarmChannel {
  target: string
  resolvedAt: number
}

export interface WarmStatus {
  warm: boolean
  resolvedAt?: number
}

const warmChannels = new Map<string, WarmChannel>()
// Whether each key's most recent warm attempt succeeded — how we tell a game
// that's run past its guide slot (still live) from one that's over.
const lastWarmOk = new Map<string, boolean>()
// A refresh pass and the event ticker can both reach the same key; share one
// resolve instead of launching duplicate browsers.
const inFlight = new Map<string, Promise<boolean>>()
// Bumped by invalidateChannel() so a resolve that was already running for a
// key's old URL can't write its (now wrong) result back when it finishes.
// Never pruned: resetting a key's count could make a stale resolve current again.
const generation = new Map<string, number>()

// Most resolved streams are
// fetchable by any normal HTTP client, but a handful of CDNs fingerprint the
// TLS/HTTP client and reject anything that isn't a real browser — the only
// way to tell is to actually try the fetch.
async function isFetchableByProxy(stream: ResolvedStream): Promise<boolean> {
  if (stream.type !== 'hls') return true
  try {
    const res = await fetch(stream.streamUrl, {
      headers: stream.headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    })
    if (!res.ok) return false
    const text = await res.text()
    return text.trimStart().startsWith('#EXTM3U')
  } catch {
    return false
  }
}

async function resolveToTarget(favorite: WarmSource): Promise<string> {
  const stream = await resolve(favorite.url, () => {})
  if (stream.type === 'dash') throw new Error('DASH streams are not supported yet.')

  let relayTarget: string | undefined
  if (!(await isFetchableByProxy(stream))) {
    if (!stream.relayTarget) throw new Error('Could not find a playable stream on that page.')
    // Check the relay can actually produce a playlist now, so warm status is
    // honest — but don't keep its browser running. The session relaunches it
    // on the first real request (ensureRelay), and an idle browser would
    // just be swept after 30s anyway.
    const relay = await BrowserRelay.start(stream.relayTarget)
    const ok = await relay.waitForPlaylist(RELAY_STARTUP_TIMEOUT_MS)
    await relay.close()
    if (!ok) throw new Error('Could not find a playable stream on that page.')
    relayTarget = stream.relayTarget
  }

  const session = createSession({
    sourceUrl: stream.sourceUrl,
    streamUrl: stream.streamUrl,
    type: stream.type,
    headers: stream.headers,
    relayTarget
  })

  return stream.type === 'direct'
    ? `${PUBLIC_BASE_URL}/stream/${session.id}/direct`
    : `${PUBLIC_BASE_URL}/stream/${session.id}/playlist.m3u8`
}

export function getWarmTarget(title: string): string | undefined {
  return warmChannels.get(title)?.target
}

export function getWarmStatus(titles: string[]): Record<string, WarmStatus> {
  return Object.fromEntries(
    titles.map((title) => {
      const entry = warmChannels.get(title)
      return entry
        ? [title, { warm: true, resolvedAt: entry.resolvedAt }]
        : [title, { warm: false }]
    })
  )
}

// A removed (or renamed) favorite's — or a finished event's — warm entry is
// otherwise unreachable (/channel/:title and /slot/:n look it up only via a
// current favorite/event) but sits in memory pointlessly. Call on changes.
export function pruneOrphanedChannels(): void {
  const activeKeys = new Set([...listFavorites().map((f) => f.title), ...listEvents().map(eventKey)])
  for (const key of warmChannels.keys()) {
    if (!activeKeys.has(key)) warmChannels.delete(key)
  }
  for (const key of lastWarmOk.keys()) {
    if (!activeKeys.has(key)) lastWarmOk.delete(key)
  }
}

// Forget everything warmed for a key — for when its URL changes, so the old
// page's stream is never handed out as the new one's.
export function invalidateChannel(key: string): void {
  generation.set(key, (generation.get(key) ?? 0) + 1)
  warmChannels.delete(key)
  lastWarmOk.delete(key)
  inFlight.delete(key)
}

export function warmChannel(source: WarmSource): Promise<boolean> {
  const existing = inFlight.get(source.title)
  if (existing) return existing
  const gen = generation.get(source.title) ?? 0
  const current = () => (generation.get(source.title) ?? 0) === gen
  const attempt = (async () => {
    try {
      const target = await resolveToTarget(source)
      if (!current()) return false
      warmChannels.set(source.title, { target, resolvedAt: Date.now() })
      lastWarmOk.set(source.title, true)
      console.log(`[channel] Warmed "${source.title}" -> ${target}`)
      return true
    } catch (err) {
      if (!current()) return false
      lastWarmOk.set(source.title, false)
      console.error(`[channel] Failed to warm "${source.title}":`, err)
      return false
    } finally {
      if (current()) inFlight.delete(source.title)
    }
  })()
  inFlight.set(source.title, attempt)
  return attempt
}

export function eventWarmSource(event: LiveEvent): WarmSource {
  return { title: eventKey(event), url: event.url }
}

// Cold-path fallback for /channel/:title when nothing's warm yet (server
// just started, or a favorite was just added) — slow, but still resolves
// rather than 404ing, since the background warm job hasn't run for it.
export const resolveChannel = resolveToTarget

function sweepEvents(): void {
  const removed = sweepFinishedEvents((e) => lastWarmOk.get(eventKey(e)))
  for (const e of removed) console.log(`[event] Cleared finished "${e.title}" from slot ${e.slot}`)
  if (removed.length > 0) {
    pruneOrphanedChannels()
    requestGuideRefresh()
  }
}

export async function refreshAllChannels(): Promise<void> {
  const sources: WarmSource[] = [...listFavorites(), ...activeEvents().map(eventWarmSource)]
  const queue = [...sources]
  const worker = async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      await warmChannel(source)
    }
  }
  await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker))
  // Some sites (the network-sniff path, with fixed 5s windows)
  // fail only under the CPU load of several Chromiums at once, and resolve
  // fine alone — so retry this pass's failures once, one at a time.
  const failed = sources.filter((source) => lastWarmOk.get(source.title) === false)
  for (const source of failed) {
    console.log(`[channel] Retrying "${source.title}" on its own…`)
    await warmChannel(source)
  }
  sweepEvents()
}

// The 30-minute refresh could open an event's warm window up to 30 minutes
// late, so check every minute for events that just became active and haven't
// been warmed yet. That also retries every minute while a stream isn't up
// yet (sites often only go live right at start time) — but only until the
// padded end; after that, the normal refresh's liveness check is enough.
const EVENT_TICK_MS = 60 * 1000

function warmNewlyActiveEvents(): void {
  const now = Date.now()
  for (const event of activeEvents(now)) {
    if (!warmChannels.has(eventKey(event)) && now < endsAt(event)) void warmChannel(eventWarmSource(event))
  }
  sweepEvents()
}

setInterval(refreshAllChannels, REFRESH_INTERVAL_MS).unref()
setInterval(warmNewlyActiveEvents, EVENT_TICK_MS).unref()
