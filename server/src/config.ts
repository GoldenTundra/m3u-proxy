// Must be the host's LAN-reachable address (never localhost/docker-internal
// hostnames) — Channels DVR, Plex, or the IPTV app fetches these URLs
// directly over the network.
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '')
if (!publicBaseUrl) {
  throw new Error('PUBLIC_BASE_URL env var is required (e.g. http://192.168.1.20:9090)')
}
export const PUBLIC_BASE_URL: string = publicBaseUrl

export const PORT = Number(process.env.PORT ?? 8080)
// How the server reaches itself from inside the container.
export const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}`

// Where favorites, events, caches, and the yt-dlp binary live — the volume
// mounted in docker-compose.yml.
export const DATA_DIR = process.env.DATA_DIR ?? process.env.YTDLP_DATA_DIR ?? '/data/bin'
