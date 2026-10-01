import axios from 'axios'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { DATA_DIR } from '../config'

// Free, static, CC0-licensed catalogs from https://iptv-org.github.io/api/ —
// no auth, no rate limit. We only keep the slice of channels.json that also
// has a tvguide.com entry in guides.json, since that's the only grabber
// wired up (see shared/guide/tvguideCom.ts) — no point offering a channel
// in the picker that we can't actually fetch a schedule for.
const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json'
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json'
const GUIDES_URL = 'https://iptv-org.github.io/api/guides.json'

const CATALOG_CACHE_FILE = process.env.CATALOG_CACHE_FILE ?? join(DATA_DIR, 'catalog.json')
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface CatalogEntry {
  tvgId: string
  tvgName: string
  tvgLogo?: string
  country?: string
  // tvguide.com's per-channel schedule id, used by guideStore to grab data.
  siteId: string
}

interface IptvOrgChannel {
  id: string
  name: string
  country?: string
}

interface IptvOrgLogo {
  channel: string
  url: string
  format?: string
}

// Channels DVR (and most IPTV client apps) don't rasterize SVG for channel
// icons — they just silently show no logo. A meaningful slice of iptv-org's
// catalog (~1300 channels) stores raw .svg logos, so route those through an
// image proxy to get a PNG a client can actually render.
function toRenderableLogo(logo: IptvOrgLogo): string {
  if (logo.format?.toUpperCase() !== 'SVG') return logo.url
  return `https://wsrv.nl/?url=${encodeURIComponent(logo.url)}&output=png`
}

interface IptvOrgGuide {
  channel: string
  site: string
  site_id: string
}

let cache: CatalogEntry[] | undefined

async function rebuild(): Promise<CatalogEntry[]> {
  const [channels, logos, guides] = await Promise.all([
    axios.get<IptvOrgChannel[]>(CHANNELS_URL).then((r) => r.data),
    axios.get<IptvOrgLogo[]>(LOGOS_URL).then((r) => r.data),
    axios.get<IptvOrgGuide[]>(GUIDES_URL).then((r) => r.data)
  ])

  const channelsById = new Map(channels.map((c) => [c.id, c]))
  const logoById = new Map(logos.map((l) => [l.channel, toRenderableLogo(l)]))

  const entries: CatalogEntry[] = []
  for (const guide of guides) {
    if (guide.site !== 'tvguide.com') continue
    const channel = channelsById.get(guide.channel)
    if (!channel) continue
    entries.push({
      tvgId: channel.id,
      tvgName: channel.name,
      tvgLogo: logoById.get(channel.id),
      country: channel.country,
      siteId: guide.site_id
    })
  }

  mkdirSync(dirname(CATALOG_CACHE_FILE), { recursive: true })
  writeFileSync(CATALOG_CACHE_FILE, JSON.stringify(entries))
  return entries
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  if (cache) return cache

  const isStale =
    !existsSync(CATALOG_CACHE_FILE) || Date.now() - statSync(CATALOG_CACHE_FILE).mtimeMs > REFRESH_INTERVAL_MS

  if (isStale) {
    try {
      cache = await rebuild()
      return cache
    } catch (err) {
      console.error('[catalog] Failed to refresh from iptv-org, falling back to cached copy if any:', err)
    }
  }

  if (existsSync(CATALOG_CACHE_FILE)) {
    cache = JSON.parse(readFileSync(CATALOG_CACHE_FILE, 'utf8'))
    return cache!
  }

  throw new Error('No catalog available and iptv-org fetch failed')
}

export async function searchCatalog(query: string, limit = 20): Promise<CatalogEntry[]> {
  const entries = await loadCatalog()
  const q = query.trim().toLowerCase()
  if (!q) return []

  const starts: CatalogEntry[] = []
  const contains: CatalogEntry[] = []
  for (const entry of entries) {
    const name = entry.tvgName.toLowerCase()
    if (name.startsWith(q)) starts.push(entry)
    else if (name.includes(q)) contains.push(entry)
  }
  return [...starts, ...contains].slice(0, limit)
}

export async function getCatalogEntry(tvgId: string): Promise<CatalogEntry | undefined> {
  const entries = await loadCatalog()
  return entries.find((e) => e.tvgId === tvgId)
}
