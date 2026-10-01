import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { listFavorites } from '../favorites/favoritesStore'
import { getCatalogEntry } from './catalog'
import { grabTvGuideCom, GuideProgram } from '../shared/guide/tvguideCom'
import { DATA_DIR } from '../config'

const GUIDE_CACHE_FILE = process.env.GUIDE_CACHE_FILE ?? join(DATA_DIR, 'guide-cache.json')
const GUIDE_DAYS = 2
// tvguide.com's per-program detail fetch is one HTTP request per program, so
// a full refresh of even a handful of channels is not cheap on their
// backend — daily is plenty for a schedule that only needs to be roughly
// accurate, and keeps us a well-behaved, low-volume client.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

interface CachedChannel {
  programs: GuideProgram[]
  fetchedAt: number
}

let cache = new Map<string, CachedChannel>()

function load(): void {
  if (!existsSync(GUIDE_CACHE_FILE)) return
  try {
    const raw = JSON.parse(readFileSync(GUIDE_CACHE_FILE, 'utf8')) as Record<
      string,
      { fetchedAt: number; programs: Array<Omit<GuideProgram, 'start' | 'stop'> & { start: string; stop: string }> }
    >
    cache = new Map(
      Object.entries(raw).map(([tvgId, entry]) => [
        tvgId,
        {
          fetchedAt: entry.fetchedAt,
          programs: entry.programs.map((p) => ({ ...p, start: new Date(p.start), stop: new Date(p.stop) }))
        }
      ])
    )
  } catch (err) {
    console.error('[guide] Failed to load cache file:', err)
  }
}

function persist(): void {
  mkdirSync(dirname(GUIDE_CACHE_FILE), { recursive: true })
  const raw = Object.fromEntries(cache.entries())
  writeFileSync(GUIDE_CACHE_FILE, JSON.stringify(raw))
}

export function getPrograms(tvgId: string): GuideProgram[] {
  return cache.get(tvgId)?.programs ?? []
}

export async function refreshChannel(tvgId: string): Promise<void> {
  const entry = await getCatalogEntry(tvgId)
  if (!entry) {
    console.error(`[guide] No catalog entry for tvgId=${tvgId}, skipping`)
    return
  }
  try {
    const programs = await grabTvGuideCom(entry.siteId, GUIDE_DAYS)
    cache.set(tvgId, { programs, fetchedAt: Date.now() })
    persist()
    console.log(`[guide] Refreshed ${tvgId} (${entry.tvgName}): ${programs.length} programs`)
  } catch (err) {
    console.error(`[guide] Failed to refresh ${tvgId}:`, err)
  }
}

export async function refreshAllGuides(): Promise<void> {
  const tvgIds = [...new Set(listFavorites().map((f) => f.tvgId).filter((id): id is string => !!id))]
  for (const tvgId of tvgIds) {
    await refreshChannel(tvgId)
  }
}

// A removed (or re-mapped) favorite's old tvgId would otherwise sit around
// forever in the cache — invisible in /guide.xml (it's filtered by current
// favorites there) but a pointless leak. Call this whenever favorites change.
export function pruneOrphanedChannels(): void {
  const activeTvgIds = new Set(listFavorites().map((f) => f.tvgId).filter((id): id is string => !!id))
  let changed = false
  for (const tvgId of cache.keys()) {
    if (!activeTvgIds.has(tvgId)) {
      cache.delete(tvgId)
      changed = true
    }
  }
  if (changed) persist()
}

load()
setInterval(refreshAllGuides, REFRESH_INTERVAL_MS).unref()
