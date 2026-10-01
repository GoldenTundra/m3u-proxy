// Adapted from iptv-org/epg's sites/tvguide.com/tvguide.com.config.js
// (https://github.com/iptv-org/epg, CC0) — only the `channel`/`date`
// plumbing changed, to run this one site's grabber directly instead of
// through the full epg-grabber CLI engine (which pulls in dozens of other
// sites' dependencies we don't need, e.g. puppeteer for browser-driven
// sites). url()/parser() logic is otherwise unchanged (2026-09-22).
import axios from 'axios'

const PROVIDER_ID = '9100001138'
const SEGMENT_MINUTES = 240
const SEGMENTS_PER_DAY = (24 * 60) / SEGMENT_MINUTES

const HEADERS = {
  referer: 'https://www.tvguide.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
}

export interface GuideProgram {
  title: string
  description?: string
  categories?: string[]
  start: Date
  stop: Date
  // Emits XMLTV <new /> — marks a first airing (live events), so Channels
  // DVR doesn't treat it as a rerun.
  isNew?: boolean
}

interface TvGuideItem {
  channel: { sourceId: number | string }
  programSchedules: Array<{
    title: string
    startTime: number
    endTime: number
    programDetails?: string
  }>
}

function scheduleUrl(startUnixSeconds: number, segment: number): string {
  const start = startUnixSeconds + (segment - 1) * SEGMENT_MINUTES * 60
  return `https://backend.tvguide.com/tvschedules/tvguide/${PROVIDER_ID}/web?start=${start}&duration=${SEGMENT_MINUTES}`
}

async function fetchSegment(startUnixSeconds: number, segment: number): Promise<TvGuideItem[]> {
  const res = await axios.get(scheduleUrl(startUnixSeconds, segment), { headers: HEADERS })
  return res.data?.data?.items ?? []
}

// Fetches `days` worth of schedule for a single tvguide.com site_id.
// Program descriptions/genres live behind a per-program detail URL
// (`programDetails`), fetched individually — same as the original grabber.
export async function grabTvGuideCom(siteId: string, days: number): Promise<GuideProgram[]> {
  const programs: GuideProgram[] = []
  const startOfToday = Math.floor(Date.now() / 1000 / 86400) * 86400
  const totalSegments = SEGMENTS_PER_DAY * days

  const queue: Array<{ title: string; start: number; stop: number; detailUrl?: string }> = []
  for (let segment = 1; segment <= totalSegments; segment++) {
    const items = await fetchSegment(startOfToday, segment)
    const match = items.find((i) => String(i.channel.sourceId) === siteId)
    if (!match) continue
    for (const p of match.programSchedules) {
      queue.push({ title: p.title, start: p.startTime, stop: p.endTime, detailUrl: p.programDetails })
    }
  }

  for (const item of queue) {
    let description: string | undefined
    let categories: string[] | undefined
    if (item.detailUrl) {
      try {
        const res = await axios.get(item.detailUrl, { headers: HEADERS })
        const detail = res.data?.data?.item
        description = detail?.description
        categories = Array.isArray(detail?.genres) ? detail.genres.map((g: { name: string }) => g.name) : undefined
      } catch {
        // Fall through with just the title/times from the schedule listing.
      }
    }
    programs.push({
      title: item.title,
      description,
      categories,
      start: new Date(item.start * 1000),
      stop: new Date(item.stop * 1000)
    })
  }

  return programs
}
