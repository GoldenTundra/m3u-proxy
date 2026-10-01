// Pure functions for rewriting HLS manifests so every URI (variant
// playlists, alternate-media renditions, encryption keys, init segments,
// and media segments) routes back through our own proxy instead of
// pointing straight at the upstream CDN. This lets us attach headers
// server-side that DVRs and players can't send themselves.

const URI_ATTR_RE = /URI="([^"]+)"/

function resolveAgainst(base: string, uri: string): string {
  return new URL(uri, base).toString()
}

// ffmpeg's HLS demuxer (which the Plex tuner endpoint, routes/hdhr.ts, runs
// on these playlists) refuses segment URLs that don't end in a media file
// extension. So the upstream URL goes in the path, followed by its own
// extension — or .ts when it has none or a disguised one (e.g. .webp; see
// segmentUnwrap.ts). The route ignores the extension.
const MEDIA_EXTENSIONS = new Set(['ts', 'm4s', 'mp4', 'm4a', 'm4v', 'aac', 'ac3', 'ec3', 'mp3', 'vtt', 'webvtt', 'cmfv', 'cmfa'])

export function encodeSegmentUrl(sessionId: string, absoluteUrl: string): string {
  const encoded = Buffer.from(absoluteUrl, 'utf8').toString('base64url')
  const ext = /\.([a-z0-9]+)$/i.exec(new URL(absoluteUrl).pathname)?.[1]?.toLowerCase()
  return `/stream/${sessionId}/segment/${encoded}.${ext && MEDIA_EXTENSIONS.has(ext) ? ext : 'ts'}`
}

export function decodeSegmentUrl(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8')
}

export function isMasterPlaylist(text: string): boolean {
  return text.split('\n').some((line) => line.startsWith('#EXT-X-STREAM-INF'))
}

export interface RewriteMasterResult {
  rewritten: string
  variants: string[] // absolute upstream URLs, indexed to match /media/:idx.m3u8
}

export function rewriteMasterPlaylist(
  text: string,
  baseUrl: string,
  sessionId: string
): RewriteMasterResult {
  const variants: string[] = []
  const lines = text.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('#EXT-X-MEDIA') && URI_ATTR_RE.test(line)) {
      // Alternate rendition (audio/subtitles) — URI is an attribute on this line.
      const match = line.match(URI_ATTR_RE)!
      const absolute = resolveAgainst(baseUrl, match[1])
      const idx = variants.push(absolute) - 1
      out.push(line.replace(URI_ATTR_RE, `URI="/stream/${sessionId}/media/${idx}.m3u8"`))
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(line)
      const next = lines[i + 1]
      if (next !== undefined && next.trim() !== '' && !next.startsWith('#')) {
        const absolute = resolveAgainst(baseUrl, next.trim())
        const idx = variants.push(absolute) - 1
        out.push(`/stream/${sessionId}/media/${idx}.m3u8`)
        i++ // consume the URI line we just replaced
      }
      continue
    }

    out.push(line)
  }

  return { rewritten: out.join('\n'), variants }
}

export function rewriteMediaPlaylist(text: string, baseUrl: string, sessionId: string): string {
  const lines = text.split('\n')
  const out: string[] = []

  for (const line of lines) {
    if ((line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) && URI_ATTR_RE.test(line)) {
      const match = line.match(URI_ATTR_RE)!
      const absolute = resolveAgainst(baseUrl, match[1])
      out.push(line.replace(URI_ATTR_RE, `URI="${encodeSegmentUrl(sessionId, absolute)}"`))
      continue
    }

    if (line.trim() !== '' && !line.startsWith('#')) {
      const absolute = resolveAgainst(baseUrl, line.trim())
      out.push(encodeSegmentUrl(sessionId, absolute))
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}
