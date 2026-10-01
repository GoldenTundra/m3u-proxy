import { Router } from 'express'
import { PUBLIC_BASE_URL } from '../config'
import { cleanText, m3uAttr, parseHttpUrl } from './validate'
import { addFavorite, listFavorites, removeFavorite, updateFavoriteUrl } from '../favorites/favoritesStore'
import { searchCatalog } from '../guide/catalog'
import { SLOT_COUNT, slotChannelNumber, slotName } from '../events/eventStore'
import { requestGuideRefresh, requestLineupRefresh } from '../channels/channelsDvr'
import { slotTvgId } from './guide'
import { refreshChannel as refreshGuideChannel, pruneOrphanedChannels as pruneOrphanedGuides } from '../guide/guideStore'
import {
  getWarmTarget,
  getWarmStatus,
  invalidateChannel,
  resolveChannel,
  warmChannel,
  pruneOrphanedChannels as pruneOrphanedSessions
} from '../channels/channelStore'

export const playlistRouter = Router()

// One #EXTINF entry per favorite, each pointing at a stable per-channel URL
// rather than a resolved stream URL — resolved URLs are often signed and
// expire, so baking them into the M3U would go stale. Channels DVR/the IPTV
// app re-requests /channel/:title every time it tunes in, which re-resolves
// from scratch and always gets a fresh URL.
playlistRouter.get('/playlist.m3u', (_req, res) => {
  const lines = ['#EXTM3U']
  const favorites = [...listFavorites()].sort((a, b) => (a.channelNumber ?? 0) - (b.channelNumber ?? 0))
  for (const favorite of favorites) {
    const attrs = [
      // Channels DVR reads channel-number; tvg-chno is the more common IPTV spelling.
      favorite.channelNumber ? `channel-number="${favorite.channelNumber}" tvg-chno="${favorite.channelNumber}"` : '',
      favorite.tvgId ? `tvg-id="${m3uAttr(favorite.tvgId)}"` : '',
      favorite.tvgLogo ? `tvg-logo="${m3uAttr(favorite.tvgLogo)}"` : ''
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`#EXTINF:-1${attrs ? ' ' + attrs : ''},${cleanText(favorite.title) ?? ''}`)
    lines.push(`${PUBLIC_BASE_URL}/channel/${encodeURIComponent(favorite.title)}`)
  }
  // Always listed, even when empty, so Channels DVR's lineup never changes —
  // the guide says what's on each (see routes/events.ts, routes/guide.ts).
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const chno = slotChannelNumber(slot)
    lines.push(
      `#EXTINF:-1 channel-number="${chno}" tvg-chno="${chno}" tvg-id="${slotTvgId(slot)}" tvg-name="${slotName(slot)}" group-title="Live Events",${slotName(slot)}`
    )
    lines.push(`${PUBLIC_BASE_URL}/slot/${slot}`)
  }
  res.type('audio/x-mpegurl').send(lines.join('\n') + '\n')
})

// Channels DVR's tuner times out waiting for response headers well before a
// cold resolve() finishes (~20s observed), so this only ever redirects to an
// already-warm session (see channels/channelStore.ts's background refresh)
// — falling back to a synchronous resolve only for the rare cold-start case
// where the background job hasn't warmed this channel yet.
playlistRouter.get('/channel/:title', async (req, res) => {
  const favorite = listFavorites().find((f) => f.title === req.params.title)
  if (!favorite) {
    res.status(404).end('Unknown channel')
    return
  }

  const warm = getWarmTarget(favorite.title)
  if (warm) {
    res.redirect(302, warm)
    return
  }

  try {
    console.log(`[channel] ${favorite.title} not warm yet, resolving synchronously…`)
    const target = await resolveChannel(favorite)
    res.redirect(302, target)
  } catch (err) {
    console.error(`[channel] ${favorite.title} failed:`, err)
    res.status(502).end(err instanceof Error ? err.message : 'Failed to resolve channel')
  }
})

export const favoritesRouter = Router()

favoritesRouter.get('/favorites', (_req, res) => {
  res.json(listFavorites())
})

favoritesRouter.post('/favorites', (req, res) => {
  const body = req.body ?? {}
  const title = cleanText(body.title)
  const url = parseHttpUrl(body.url)
  if (!title || !url) {
    res.status(400).json({ error: 'Need a "title" and an http(s) "url"' })
    return
  }
  const favorite = {
    title,
    url,
    tvgId: cleanText(body.tvgId),
    tvgName: cleanText(body.tvgName),
    tvgLogo: parseHttpUrl(body.tvgLogo)
  }
  const favorites = addFavorite(favorite)
  res.json(favorites)
  pruneOrphanedGuides()
  requestLineupRefresh()
  warmChannel(favorite).catch((err) => console.error(`[favorites] Warming "${title}" failed:`, err))
  if (favorite.tvgId) {
    // The programme grab takes a while, so the lineup refresh above only
    // gets filler for this channel; refresh the guide again once it lands.
    refreshGuideChannel(favorite.tvgId)
      .then(requestGuideRefresh)
      .catch((err) => console.error(`[favorites] Guide refresh for ${favorite.tvgId} failed:`, err))
  }
})

// Change just the page URL, keeping the title, guide mapping, and channel
// number (so Channels DVR sees the same channel). The playlist doesn't
// change, so no lineup refresh — just drop the old URL's stream and re-warm.
favoritesRouter.patch('/favorites/:title', (req, res) => {
  const url = parseHttpUrl(req.body?.url)
  if (!url) {
    res.status(400).json({ error: 'Need an http(s) "url"' })
    return
  }
  const favorite = updateFavoriteUrl(req.params.title, url)
  if (!favorite) {
    res.status(404).json({ error: 'Unknown channel' })
    return
  }
  invalidateChannel(favorite.title)
  res.json(favorite)
  warmChannel(favorite).catch((err) => console.error(`[favorites] Warming "${favorite.title}" failed:`, err))
})

favoritesRouter.delete('/favorites/:title', (req, res) => {
  res.json(removeFavorite(req.params.title))
  pruneOrphanedSessions()
  pruneOrphanedGuides()
  requestLineupRefresh()
})

favoritesRouter.get('/channels/status', (_req, res) => {
  const titles = listFavorites().map((f) => f.title)
  res.json(getWarmStatus(titles))
})

favoritesRouter.get('/catalog/search', async (req, res) => {
  const q = req.query.q
  if (typeof q !== 'string') {
    res.json([])
    return
  }
  try {
    res.json(await searchCatalog(q))
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Catalog search failed' })
  }
})
