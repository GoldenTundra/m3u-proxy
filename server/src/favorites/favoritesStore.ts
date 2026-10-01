import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { DATA_DIR } from '../config'

export interface Favorite {
  title: string
  url: string
  // Guide mapping to a real channel in the iptv-org catalog (see
  // ../guide/catalog.ts) — absent when the favorite has no known guide-data
  // match, in which case it just shows up in Channels DVR with no schedule.
  tvgId?: string
  tvgName?: string
  tvgLogo?: string
  // Pinned channel number, written into the M3U so Channels DVR doesn't
  // auto-number by playlist position (which renumbers every later channel
  // whenever one is removed). Assigned once, never changed or reused.
  channelNumber?: number
}

// Favorites are numbered from here up; the event slots sit at 2500+ (see
// ../events/), so this leaves room for 500 favorites.
const FIRST_FAVORITE_CHANNEL = 2000

// Reuses the same mounted volume as the yt-dlp binary (./volumes/ytdlp-bin)
// so no separate volume/compose change is needed for this small file.
const FAVORITES_FILE = process.env.FAVORITES_FILE ?? join(DATA_DIR, 'favorites.json')

function nextChannelNumber(favorites: Favorite[]): number {
  const used = favorites.map((f) => f.channelNumber ?? 0)
  return Math.max(FIRST_FAVORITE_CHANNEL - 1, ...used) + 1
}

export function listFavorites(): Favorite[] {
  if (!existsSync(FAVORITES_FILE)) return []
  const favorites: Favorite[] = JSON.parse(readFileSync(FAVORITES_FILE, 'utf8'))
  // Backfill favorites saved before numbers were pinned, in their existing
  // order, so they keep the numbers Channels DVR already gave them by position.
  let changed = false
  for (const favorite of favorites) {
    if (favorite.channelNumber === undefined) {
      favorite.channelNumber = nextChannelNumber(favorites)
      changed = true
    }
  }
  if (changed) save(favorites)
  return favorites
}

function save(favorites: Favorite[]): void {
  mkdirSync(dirname(FAVORITES_FILE), { recursive: true })
  writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2))
}

export function addFavorite(favorite: Favorite): Favorite[] {
  const all = listFavorites()
  // Re-saving an existing title (e.g. to change its URL or guide mapping)
  // keeps its number; a new one gets the next number after the highest, never
  // a removed one's — Channels DVR may still associate that number with the old channel.
  const channelNumber = all.find((f) => f.title === favorite.title)?.channelNumber ?? nextChannelNumber(all)
  const favorites = all.filter((f) => f.title !== favorite.title)
  favorites.push({ ...favorite, channelNumber })
  save(favorites)
  return favorites
}

export function removeFavorite(title: string): Favorite[] {
  const favorites = listFavorites().filter((f) => f.title !== title)
  save(favorites)
  return favorites
}

// Returns undefined if there's no favorite with that title.
export function updateFavoriteUrl(title: string, url: string): Favorite | undefined {
  const favorites = listFavorites()
  const favorite = favorites.find((f) => f.title === title)
  if (!favorite) return undefined
  favorite.url = url
  save(favorites)
  return favorite
}
