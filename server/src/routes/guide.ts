import { Router } from 'express'
import { listFavorites } from '../favorites/favoritesStore'
import { getPrograms } from '../guide/guideStore'
import type { GuideProgram } from '../shared/guide/tvguideCom'
import { SLOT_COUNT, endsAt, eventsForSlot, slotChannelNumber, slotName, LiveEvent, Sport } from '../events/eventStore'

export const guideRouter = Router()

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// XMLTV timestamps: YYYYMMDDHHMMSS +0000 (we always emit UTC).
function xmltvDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

const FILLER_TITLE = 'Live Programming'
const FILLER_SPAN_MS = 24 * 60 * 60 * 1000

// Channels DVR only re-pulls this file on its own schedule ("Refresh Daily"
// in its Custom Channels config), not on demand — so if it happens to poll
// right after a channel is newly added (before its first guide grab has
// finished) or across some other gap in the real data, it caches that hole
// for a full day and won't let you tune in until something covers "now".
// Guaranteeing there's always *something* covering every moment — even a
// generic placeholder — makes that race harmless regardless of when
// Channels DVR happens to poll.
function fillGaps(programs: GuideProgram[]): GuideProgram[] {
  if (programs.length === 0) {
    const start = new Date()
    return [{ title: FILLER_TITLE, start, stop: new Date(start.getTime() + FILLER_SPAN_MS) }]
  }
  const sorted = [...programs].sort((a, b) => a.start.getTime() - b.start.getTime())
  const filled: GuideProgram[] = []
  let cursor = sorted[0].start
  for (const program of sorted) {
    if (program.start.getTime() > cursor.getTime()) {
      filled.push({ title: FILLER_TITLE, start: cursor, stop: program.start })
    }
    filled.push(program)
    if (program.stop.getTime() > cursor.getTime()) cursor = program.stop
  }
  return filled
}

export function slotTvgId(slot: number): string {
  return `m3u-proxy.live-event-${slot}`
}

const NO_EVENT_TITLE = 'No event scheduled'
// Channels DVR only re-pulls the guide daily, so an empty slot's filler has
// to cover well past its next poll.
const SLOT_FILLER_SPAN_MS = 48 * 60 * 60 * 1000
const SPORT_LABEL: Record<Sport, string> = {
  hockey: 'Hockey',
  football: 'Football',
  basketball: 'Basketball',
  baseball: 'Baseball',
  soccer: 'Soccer',
  other: 'Sports'
}

// "Tue 7:00 PM", or just "7:00 PM" for today — in the TZ from
// docker-compose.yml, since the container itself defaults to UTC.
function formatStart(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? time : `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

// Before a game: "Up next: …"; during: the matchup itself (padded, see
// SPORT_DURATION_MIN); after: "No event scheduled" or the next "Up next".
// Never a score — recordings would get spoiled.
function slotPrograms(slot: number): GuideProgram[] {
  const programs: GuideProgram[] = []
  const windowStart = Date.now() - 60 * 60 * 1000
  const upcoming = eventsForSlot(slot).filter((e) => endsAt(e) > windowStart)
  // Start no later than a game already in progress, so it's listed at its
  // real start time rather than clipped to the window.
  let cursor = Math.min(windowStart, upcoming[0]?.startsAt ?? windowStart)
  upcoming.forEach((event: LiveEvent, i) => {
    const start = Math.max(event.startsAt, cursor)
    if (start > cursor) {
      programs.push({
        title: `Up next: ${event.title}, ${formatStart(event.startsAt)}`,
        description: `${event.title} starts ${formatStart(event.startsAt)} on ${slotName(slot)}.`,
        start: new Date(cursor),
        stop: new Date(start)
      })
    }
    // A queued game takes over at its start (see activeEvent), so cut this
    // one short in the guide too.
    const next = upcoming[i + 1]
    const stop = next ? Math.min(endsAt(event), Math.max(next.startsAt, start)) : endsAt(event)
    if (stop > start) {
      programs.push({
        title: event.title,
        description: `${SPORT_LABEL[event.sport]} on ${slotName(slot)}.`,
        categories: ['Sports', 'Sports event', SPORT_LABEL[event.sport]],
        start: new Date(start),
        stop: new Date(stop),
        isNew: true
      })
    }
    cursor = Math.max(cursor, stop)
  })
  const horizon = Date.now() + SLOT_FILLER_SPAN_MS
  if (cursor < horizon) {
    programs.push({ title: NO_EVENT_TITLE, start: new Date(cursor), stop: new Date(horizon) })
  }
  return programs
}

function programmeXml(tvgId: string, program: GuideProgram): string {
  const parts = [
    `  <programme start="${xmltvDate(program.start)}" stop="${xmltvDate(program.stop)}" channel="${escapeXml(tvgId)}">`,
    `    <title>${escapeXml(program.title)}</title>`
  ]
  if (program.description) parts.push(`    <desc>${escapeXml(program.description)}</desc>`)
  for (const category of program.categories ?? []) {
    parts.push(`    <category>${escapeXml(category)}</category>`)
  }
  if (program.isNew) parts.push('    <new />')
  parts.push('  </programme>')
  return parts.join('\n')
}

interface GuideChannel {
  id: string
  names: string[]
  logo?: string
  programs: GuideProgram[]
}

function guideXml(channels: GuideChannel[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="m3u-proxy">']
  for (const channel of channels) {
    lines.push(`  <channel id="${escapeXml(channel.id)}">`)
    for (const name of channel.names) lines.push(`    <display-name>${escapeXml(name)}</display-name>`)
    if (channel.logo) lines.push(`    <icon src="${escapeXml(channel.logo)}" />`)
    lines.push('  </channel>')
  }
  for (const channel of channels) {
    for (const program of channel.programs) lines.push(programmeXml(channel.id, program))
  }
  lines.push('</tv>')
  return lines.join('\n') + '\n'
}

function slotChannels(id: (slot: number) => string, names: (slot: number) => string[]): GuideChannel[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({
    id: id(i + 1),
    names: names(i + 1),
    programs: slotPrograms(i + 1)
  }))
}

// Keyed by tvg-id, which Channels DVR matches against the M3U's tvg-id. Only
// favorites with a resolved tvg-id (set via the admin console's channel
// picker) show up here — the rest just have no schedule, same as any
// unmapped custom channel.
guideRouter.get('/guide.xml', (_req, res) => {
  const channels: GuideChannel[] = []
  const seenIds = new Set<string>()
  for (const favorite of listFavorites()) {
    if (!favorite.tvgId || seenIds.has(favorite.tvgId)) continue
    seenIds.add(favorite.tvgId)
    channels.push({
      id: favorite.tvgId,
      names: [favorite.tvgName ?? favorite.title],
      logo: favorite.tvgLogo,
      programs: fillGaps(getPrograms(favorite.tvgId))
    })
  }
  channels.push(...slotChannels(slotTvgId, (slot) => [slotName(slot)]))
  res.type('application/xml').send(guideXml(channels))
})

// Plex has no tvg-id: it matches XMLTV channels to the tuner lineup
// (routes/hdhr.ts) by channel number, so key everything by that instead.
// Unmapped favorites get filler, so every channel is tunable from the guide.
guideRouter.get('/plex/guide.xml', (_req, res) => {
  const channels: GuideChannel[] = listFavorites()
    .filter((f) => f.channelNumber !== undefined)
    .map((favorite) => {
      const number = String(favorite.channelNumber)
      return {
        id: number,
        names: [number, favorite.title],
        logo: favorite.tvgLogo,
        programs: fillGaps(favorite.tvgId ? getPrograms(favorite.tvgId) : [])
      }
    })
  channels.push(
    ...slotChannels(
      (slot) => String(slotChannelNumber(slot)),
      (slot) => [String(slotChannelNumber(slot)), slotName(slot)]
    )
  )
  res.type('application/xml').send(guideXml(channels))
})
