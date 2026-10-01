import { Router, Request, Response } from 'express'
import { Readable } from 'stream'
import { getSession, ensureRelay, Session } from '../sessions/sessionStore'
import type { CachedSegment } from '../shared/browserRelay'
import { unwrapSegment } from './segmentUnwrap'
import {
  isMasterPlaylist,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  decodeSegmentUrl
} from './hlsRewrite'

export const proxyRouter = Router()

// ensureRelay already waited for the relay page's first playlist, so this
// is just covering the gap between live-manifest refreshes, not a cold
// start — much shorter than the startup wait.
const PLAYLIST_WAIT_TIMEOUT_MS = 5000

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Upstream returned ${res.status} for ${url}`)
  return res.text()
}

async function proxyUpstream(
  upstreamUrl: string,
  headers: Record<string, string> | undefined,
  req: Request,
  res: Response
): Promise<void> {
  const fetchHeaders: Record<string, string> = { ...headers }
  const range = req.headers.range
  if (range) fetchHeaders['Range'] = range

  const upstream = await fetch(upstreamUrl, { headers: fetchHeaders })
  const contentType = upstream.headers.get('content-type') ?? ''
  // Possibly a TS segment disguised as an image (see segmentUnwrap.ts) —
  // has to be buffered to strip the fake header, so can't be piped.
  if (upstream.ok && /^image\//i.test(contentType)) {
    const unwrapped = unwrapSegment(Buffer.from(await upstream.arrayBuffer()), contentType)
    res.type(unwrapped.contentType).send(unwrapped.body)
    return
  }
  res.status(upstream.status)
  upstream.headers.forEach((value, key) => {
    if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) return
    res.setHeader(key, value)
  })
  if (!upstream.body) {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body as never).pipe(res)
}

// Cheapest source first. Segments often live on a different, non-
// fingerprinting CDN than the playlists (e.g. a public image CDN),
// so a plain fetch usually works even when the playlist needed the relay.
async function fetchRelaySegment(session: Session, url: string): Promise<CachedSegment | undefined> {
  const relay = await ensureRelay(session)
  const cached = relay.getCachedSegment(url)
  if (cached) return cached

  const direct = await fetch(url, { headers: session.headers }).catch(() => undefined)
  if (direct?.ok) {
    return {
      body: Buffer.from(await direct.arrayBuffer()),
      contentType: direct.headers.get('content-type') ?? ''
    }
  }

  const inPage = await relay.fetchBytes(url).catch(() => undefined)
  if (inPage) return inPage

  // Last resort: the page's own player may be about to fetch it.
  return relay.getSegment(url)
}

proxyRouter.get('/:sessionId/playlist.m3u8', async (req, res) => {
  const session = getSession(req.params.sessionId)
  if (!session) {
    res.status(404).end('Unknown session')
    return
  }
  try {
    let text: string
    let baseUrl: string
    if (session.relayTarget) {
      const relay = await ensureRelay(session)
      const playlist = await relay.waitForPlaylist(PLAYLIST_WAIT_TIMEOUT_MS)
      if (!playlist) throw new Error('No playlist observed yet')
      // Re-fetch it in-page rather than trusting the observed copy: the
      // page's player may never refresh it (see browserRelay.ts on missing
      // codecs), so for a live media playlist the observed body goes stale.
      text = await relay.fetchText(playlist.url).catch(() => playlist.body)
      baseUrl = playlist.url
    } else {
      text = await fetchText(session.streamUrl, session.headers)
      baseUrl = session.streamUrl
    }
    res.type('application/vnd.apple.mpegurl')
    if (isMasterPlaylist(text)) {
      const { rewritten, variants } = rewriteMasterPlaylist(text, baseUrl, session.id)
      session.variants = variants
      res.send(rewritten)
    } else {
      res.send(rewriteMediaPlaylist(text, baseUrl, session.id))
    }
  } catch {
    res.status(502).end('Failed to fetch upstream manifest')
  }
})

// Only reachable for a master (multi-rendition) playlist. Relay sessions
// fetch the variant in-page, since its host fingerprints clients just like
// the master's.
proxyRouter.get('/:sessionId/media/:idx.m3u8', async (req, res) => {
  const session = getSession(req.params.sessionId)
  const idx = Number(req.params.idx)
  const variantUrl = session?.variants?.[idx]
  if (!session || variantUrl === undefined) {
    res.status(404).end('Unknown session or variant')
    return
  }
  try {
    const text = session.relayTarget
      ? await (await ensureRelay(session)).fetchText(variantUrl)
      : await fetchText(variantUrl, session.headers)
    res.type('application/vnd.apple.mpegurl').send(rewriteMediaPlaylist(text, variantUrl, session.id))
  } catch {
    res.status(502).end('Failed to fetch upstream variant playlist')
  }
})

async function serveSegment(req: Request, res: Response, encoded: string | undefined): Promise<void> {
  const session = getSession(req.params.sessionId)
  if (!session || !encoded) {
    res.status(404).end('Unknown session or segment')
    return
  }
  try {
    const upstreamUrl = decodeSegmentUrl(encoded)
    if (session.relayTarget) {
      const segment = await fetchRelaySegment(session, upstreamUrl)
      if (!segment) {
        res.status(502).end('Segment never showed up in the relay')
        return
      }
      const unwrapped = unwrapSegment(segment.body, segment.contentType)
      res.type(unwrapped.contentType).send(unwrapped.body)
      return
    }
    await proxyUpstream(upstreamUrl, session.headers, req, res)
  } catch {
    res.status(502).end('Failed to fetch upstream segment')
  }
}

// See encodeSegmentUrl for why the extension is there; base64url never
// contains a dot, so everything after the first one is it.
proxyRouter.get('/:sessionId/segment/:encoded', (req, res) => serveSegment(req, res, req.params.encoded.split('.')[0]))

proxyRouter.get('/:sessionId/direct', async (req, res) => {
  const session = getSession(req.params.sessionId)
  if (!session) {
    res.status(404).end('Unknown session')
    return
  }
  try {
    await proxyUpstream(session.streamUrl, session.headers, req, res)
  } catch {
    res.status(502).end('Failed to fetch upstream stream')
  }
})
