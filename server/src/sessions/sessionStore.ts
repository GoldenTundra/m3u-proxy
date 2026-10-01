import { randomBytes } from 'crypto'
import type { StreamType } from '../shared/types/stream'
import { BrowserRelay } from '../shared/browserRelay'

export interface Session {
  id: string
  sourceUrl: string
  streamUrl: string
  type: StreamType
  headers?: Record<string, string>
  variants?: string[]
  createdAt: number
  lastAccessedAt: number
  // Set only for streams that need a live browser relaying the actual
  // fetches (see browserRelay.ts) — absent for the normal direct-proxy path.
  // The relay itself is started on demand (ensureRelay) and torn down when
  // idle, but the session outlives it: warm channels hand out this
  // session's URL long before anyone tunes in, and must stay valid.
  relayTarget?: string
  relay?: BrowserRelay
  relayStarting?: Promise<BrowserRelay>
}

const TTL_MS = 6 * 60 * 60 * 1000 // 6h — generous for a movie plus margin
const RELAY_SWEEP_INTERVAL_MS = 15_000
// The headless relay page keeps playing (and fetching) on its own real-time
// clock regardless of whether the client is still asking for anything, so
// its own fetch activity can't tell us whether playback actually stopped.
// Proxy-request idleness is the real signal — a live HLS client reloads its
// playlist every few seconds, so this many seconds of silence means nobody's
// watching anymore.
const RELAY_IDLE_TIMEOUT_MS = 30_000
// How long a freshly started relay page gets to produce its first playlist.
const RELAY_STARTUP_TIMEOUT_MS = 15_000
const sessions = new Map<string, Session>()

export function createSession(input: Omit<Session, 'id' | 'createdAt' | 'lastAccessedAt'>): Session {
  const id = randomBytes(4).toString('hex')
  const now = Date.now()
  const session: Session = { ...input, id, createdAt: now, lastAccessedAt: now }
  sessions.set(id, session)
  return session
}

export function getSession(id: string): Session | undefined {
  const session = sessions.get(id)
  if (session) session.lastAccessedAt = Date.now()
  return session
}

// Starts (or reuses) this session's relay browser. Concurrent callers — a
// client requesting the playlist and a segment at once — share one launch.
export async function ensureRelay(session: Session): Promise<BrowserRelay> {
  if (session.relay && !session.relay.isClosed()) return session.relay
  if (!session.relayTarget) throw new Error('Session has no relay target')
  if (!session.relayStarting) {
    const target = session.relayTarget
    session.relayStarting = (async () => {
      const relay = await BrowserRelay.start(target)
      if (!(await relay.waitForPlaylist(RELAY_STARTUP_TIMEOUT_MS))) {
        await relay.close()
        throw new Error('Relay page never produced a playlist')
      }
      session.relay = relay
      return relay
    })().finally(() => {
      session.relayStarting = undefined
    })
  }
  return session.relayStarting
}

// Drops a relay that's stopped working (page navigated away, crashed, ...)
// so the next request starts a fresh one.
export function resetRelay(session: Session): void {
  session.relay?.close()
  session.relay = undefined
}

export function sweepExpired(): void {
  const cutoff = Date.now() - TTL_MS
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      s.relay?.close()
      sessions.delete(id)
    }
  }
}

// A relay session holds a live Chromium process for as long as it lives —
// unlike the plain metadata of a direct-proxy session, that's expensive to
// leave running after playback actually stops. There's no explicit "stop
// this session" signal from the client side, so we infer it from proxy
// requests going quiet.
function sweepIdleRelays(): void {
  const cutoff = Date.now() - RELAY_IDLE_TIMEOUT_MS
  for (const [id, s] of sessions) {
    if (s.relay && s.lastAccessedAt < cutoff) {
      resetRelay(s)
      // Sessions with a relayTarget can relaunch on the next request, so
      // keep them; only the (expensive) browser goes.
      if (!s.relayTarget) sessions.delete(id)
    }
  }
}

setInterval(sweepExpired, 10 * 60 * 1000).unref()
setInterval(sweepIdleRelays, RELAY_SWEEP_INTERVAL_MS).unref()
