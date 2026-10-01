import { PUBLIC_BASE_URL } from '../config'

// Channels DVR only re-reads our playlist/guide on its own schedule (M3U
// daily, XMLTV every 6h by default), so a newly assigned Live Event or added
// favorite wouldn't show until then. Its local API (undocumented — found in
// its admin bundle's per-source menu) has a call for each:
//  - `POST /providers/m3u/sources/<name>/refresh` reloads the M3U only
//  - `PUT /dvr/lineups/<XMLTV-lineup>` re-pulls the guide (verified: ~5s)
// Event changes only need the guide (the slots themselves never change);
// favorite changes need both.
const CHANNELS_DVR_URL = process.env.CHANNELS_DVR_URL?.replace(/\/+$/, '')
const OUR_GUIDE_URL = `${PUBLIC_BASE_URL}/guide.xml`
// Several changes in a row (e.g. a sweep clearing two events) -> one refresh.
const DEBOUNCE_MS = 2000
const REQUEST_TIMEOUT_MS = 5000
const M3U_SETTLE_MS = 3000

async function dvrFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CHANNELS_DVR_URL}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

interface OurSource {
  name: string // for /providers/m3u/sources/<name>
  lineup: string // for /dvr/lineups/<lineup>
}

// Find our source by its XMLTV URL rather than a configured name, so renaming
// the source in Channels DVR doesn't silently break this. /dvr/lineups maps
// device -> lineup, e.g. {"M3U-M3UProxy": "XMLTV-M3UProxy", ...}.
async function findOurSources(): Promise<OurSource[]> {
  const lineups = (await (await dvrFetch('/dvr/lineups')).json()) as Record<string, string>
  const ours: OurSource[] = []
  for (const [deviceId, lineup] of Object.entries(lineups)) {
    if (!deviceId.startsWith('M3U-') || !lineup.startsWith('XMLTV-')) continue
    const name = deviceId.slice('M3U-'.length)
    const source = (await (await dvrFetch(`/providers/m3u/sources/${encodeURIComponent(name)}`)).json()) as {
      xmltv_url?: string
    }
    if (source.xmltv_url === OUR_GUIDE_URL) ours.push({ name, lineup })
  }
  return ours
}

async function refresh(includeM3u: boolean): Promise<void> {
  try {
    const sources = await findOurSources()
    if (sources.length === 0) {
      console.log(`[channels-dvr] No source using ${OUR_GUIDE_URL}; nothing to refresh`)
      return
    }
    for (const { name, lineup } of sources) {
      if (includeM3u) {
        const res = await dvrFetch(`/providers/m3u/sources/${encodeURIComponent(name)}/refresh`, { method: 'POST' })
        console.log(`[channels-dvr] M3U refresh for ${name}: ${res.status}`)
        // The M3U refresh returns before the new lineup is loaded; give it a
        // moment so the guide refresh sees any newly added channel.
        await new Promise((resolve) => setTimeout(resolve, M3U_SETTLE_MS))
      }
      const res = await dvrFetch(`/dvr/lineups/${encodeURIComponent(lineup)}`, { method: 'PUT' })
      console.log(`[channels-dvr] Guide refresh for ${lineup}: ${res.status}`)
    }
  } catch (err) {
    console.error('[channels-dvr] Refresh failed:', err)
  }
}

let pending: NodeJS.Timeout | undefined
let pendingIncludesM3u = false

function schedule(includeM3u: boolean): void {
  if (!CHANNELS_DVR_URL) return
  // Coalesce: a pending guide-only refresh gets upgraded if an M3U change
  // comes in before it fires.
  pendingIncludesM3u ||= includeM3u
  clearTimeout(pending)
  pending = setTimeout(() => {
    const m3u = pendingIncludesM3u
    pendingIncludesM3u = false
    void refresh(m3u)
  }, DEBOUNCE_MS)
}

// The guide changed (Live Events, or fresh programme data for a favorite).
export function requestGuideRefresh(): void {
  schedule(false)
}

// The channel list changed (a favorite added/removed/edited).
export function requestLineupRefresh(): void {
  schedule(true)
}
