import { Router } from 'express'
import {
  SLOT_COUNT,
  SPORT_DURATION_MIN,
  Sport,
  activeEvent,
  addEvent,
  endsAt,
  eventKey,
  eventsForSlot,
  listEvents,
  removeEvent,
  updateEventUrl,
  slotChannelNumber,
  slotName
} from '../events/eventStore'
import {
  eventWarmSource,
  getWarmStatus,
  getWarmTarget,
  invalidateChannel,
  pruneOrphanedChannels,
  resolveChannel,
  warmChannel
} from '../channels/channelStore'
import { requestGuideRefresh } from '../channels/channelsDvr'
import { cleanText, parseHttpUrl } from './validate'

export const slotRouter = Router()

function parseSlot(value: string): number | undefined {
  const slot = Number(value)
  return Number.isInteger(slot) && slot >= 1 && slot <= SLOT_COUNT ? slot : undefined
}

// Same warm-first behavior as /channel/:title (see routes/playlist.ts), for
// whatever event the slot is currently serving.
slotRouter.get('/slot/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot)
  const event = slot ? activeEvent(slot) : undefined
  if (!event) {
    res.status(404).end('No event on this slot right now')
    return
  }

  const warm = getWarmTarget(eventKey(event))
  if (warm) {
    res.redirect(302, warm)
    return
  }

  try {
    console.log(`[event] "${event.title}" not warm yet, resolving synchronously…`)
    res.redirect(302, await resolveChannel(eventWarmSource(event)))
  } catch (err) {
    console.error(`[event] "${event.title}" failed:`, err)
    res.status(502).end(err instanceof Error ? err.message : 'Failed to resolve event')
  }
})

export const eventsRouter = Router()

eventsRouter.get('/events', (_req, res) => {
  const warm = getWarmStatus(listEvents().map(eventKey))
  const now = Date.now()
  res.json({
    sports: SPORT_DURATION_MIN,
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => {
      const slot = i + 1
      const active = activeEvent(slot, now)
      return {
        slot,
        name: slotName(slot),
        channelNumber: slotChannelNumber(slot),
        events: eventsForSlot(slot).map((e) => ({
          ...e,
          endsAt: endsAt(e),
          active: e.id === active?.id,
          warm: warm[eventKey(e)]?.warm ?? false
        }))
      }
    })
  })
})

eventsRouter.post('/events', (req, res) => {
  const { slot, startsAt, sport } = req.body ?? {}
  const title = cleanText(req.body?.title)
  const url = parseHttpUrl(req.body?.url)
  const slotNumber = parseSlot(String(slot))
  if (!slotNumber) {
    res.status(400).json({ error: `"slot" must be 1-${SLOT_COUNT}` })
    return
  }
  if (!title || !url) {
    res.status(400).json({ error: 'Need a "title" and an http(s) "url"' })
    return
  }
  if (typeof startsAt !== 'number' || !Number.isFinite(startsAt)) {
    res.status(400).json({ error: '"startsAt" must be a timestamp in ms' })
    return
  }
  if (!(sport in SPORT_DURATION_MIN)) {
    res.status(400).json({ error: `"sport" must be one of ${Object.keys(SPORT_DURATION_MIN).join(', ')}` })
    return
  }
  const event = addEvent({ slot: slotNumber, title, url, startsAt, sport: sport as Sport })
  res.json(event)
  requestGuideRefresh()
  // Assigned inside (or after the start of) its warm window — e.g. a game
  // that's already on — so warm it now rather than waiting for the ticker.
  if (activeEvent(slotNumber)?.id === event.id) {
    warmChannel(eventWarmSource(event)).catch(() => undefined)
  }
})

// Change just the page URL (e.g. the first stream link died). The guide
// doesn't change; drop the old URL's stream and re-warm if it's on now.
eventsRouter.patch('/events/:id', (req, res) => {
  const url = parseHttpUrl(req.body?.url)
  if (!url) {
    res.status(400).json({ error: 'Need an http(s) "url"' })
    return
  }
  const event = updateEventUrl(req.params.id, url)
  if (!event) {
    res.status(404).json({ error: 'Unknown event' })
    return
  }
  invalidateChannel(eventKey(event))
  res.json(event)
  if (activeEvent(event.slot)?.id === event.id) {
    warmChannel(eventWarmSource(event)).catch(() => undefined)
  }
})

eventsRouter.delete('/events/:id', (req, res) => {
  removeEvent(req.params.id)
  pruneOrphanedChannels()
  requestGuideRefresh()
  res.json({ ok: true })
})
