import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../config'

// "Live Event" slots: a fixed set of always-present channels that one-off
// events (e.g. a single game's stream page) get assigned to. Adding and
// removing a Channels DVR channel per game would churn its lineup; instead
// the slots stay put and the guide says what's on each one (routes/guide.ts).
export const SLOT_COUNT = 3
export const FIRST_SLOT_CHANNEL = 2500

export type Sport = 'hockey' | 'football' | 'basketball' | 'baseball' | 'soccer' | 'other'

// Channels DVR stops a recording at the guide entry's end, and we can't know
// when a game actually ends — so each game is listed for a padded length
// that covers overtime/delays for its sport.
export const SPORT_DURATION_MIN: Record<Sport, number> = {
  hockey: 210,
  football: 240,
  basketball: 180,
  baseball: 210,
  soccer: 150,
  other: 210
}

// Start warming this long before the listed start, so the first tune-in is
// instant (a cold resolve takes ~20s, past Channels DVR's tuner timeout).
export const PREWARM_MS = 10 * 60 * 1000
// After the padded end, keep serving while the source is still live (the
// game ran long), then clear the event once it's gone dead…
const CLEAR_AFTER_END_MS = 60 * 60 * 1000
// …or unconditionally by here, since some sites loop a replay forever.
const HARD_CLEAR_AFTER_END_MS = 3 * 60 * 60 * 1000

export interface LiveEvent {
  id: string
  slot: number
  title: string
  url: string
  startsAt: number
  sport: Sport
}

const EVENTS_FILE = process.env.EVENTS_FILE ?? join(DATA_DIR, 'events.json')

export function listEvents(): LiveEvent[] {
  if (!existsSync(EVENTS_FILE)) return []
  return JSON.parse(readFileSync(EVENTS_FILE, 'utf8'))
}

function save(events: LiveEvent[]): void {
  mkdirSync(dirname(EVENTS_FILE), { recursive: true })
  writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2))
}

export function slotChannelNumber(slot: number): number {
  return FIRST_SLOT_CHANNEL + slot - 1
}

export function slotName(slot: number): string {
  return `Live Event ${slot}`
}

export function endsAt(event: LiveEvent): number {
  return event.startsAt + SPORT_DURATION_MIN[event.sport] * 60 * 1000
}

// Key the warm cache by event, not slot, so a slot that moves on to its next
// game can never hand out the previous game's stream.
export function eventKey(event: LiveEvent): string {
  return `event:${event.id}`
}

export function addEvent(input: Omit<LiveEvent, 'id'>): LiveEvent {
  const event = { ...input, id: randomBytes(4).toString('hex') }
  save([...listEvents(), event])
  return event
}

export function removeEvent(id: string): void {
  save(listEvents().filter((e) => e.id !== id))
}

// Returns undefined if there's no event with that id.
export function updateEventUrl(id: string, url: string): LiveEvent | undefined {
  const events = listEvents()
  const event = events.find((e) => e.id === id)
  if (!event) return undefined
  event.url = url
  save(events)
  return event
}

export function eventsForSlot(slot: number): LiveEvent[] {
  return listEvents()
    .filter((e) => e.slot === slot)
    .sort((a, b) => a.startsAt - b.startsAt)
}

// What a slot serves right now: of the events whose warm window has opened,
// the latest-starting one — so a queued game takes over at its start even if
// the previous one is still running long.
export function activeEvent(slot: number, now = Date.now()): LiveEvent | undefined {
  return eventsForSlot(slot)
    .filter((e) => e.startsAt - PREWARM_MS <= now)
    .pop()
}

export function activeEvents(now = Date.now()): LiveEvent[] {
  const events: LiveEvent[] = []
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const event = activeEvent(slot, now)
    if (event) events.push(event)
  }
  return events
}

// `isLive` reports whether the event's most recent warm attempt succeeded
// (undefined if never tried). Returns the events it removed.
export function sweepFinishedEvents(isLive: (event: LiveEvent) => boolean | undefined, now = Date.now()): LiveEvent[] {
  const events = listEvents()
  const active = new Set(activeEvents(now).map((e) => e.id))
  const finished = events.filter((e) => {
    const end = endsAt(e)
    if (now < end) return false
    if (!active.has(e.id)) return true // superseded by a later game on its slot
    if (now >= end + HARD_CLEAR_AFTER_END_MS) return true
    return now >= end + CLEAR_AFTER_END_MS && isLive(e) === false
  })
  if (finished.length > 0) save(events.filter((e) => !finished.includes(e)))
  return finished
}
