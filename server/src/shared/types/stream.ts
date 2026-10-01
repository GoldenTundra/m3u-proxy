export type StreamType = 'hls' | 'dash' | 'direct'

export interface ResolvedStream {
  sourceUrl: string
  streamUrl: string
  type: StreamType
  title?: string
  isLive?: boolean
  headers?: Record<string, string>
  // The page a real browser needs to keep open and playing to produce this
  // stream — set only for DOM-scan/network-sniff results. Some CDNs
  // fingerprint the TLS/HTTP client and reject anything that isn't an
  // actual browser, so streamUrl alone isn't enough for those; the caller
  // uses this to fall back to a browser-relay session (see browserRelay.ts).
  relayTarget?: string
}

export interface ResolveError {
  message: string
}
