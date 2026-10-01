import { Router } from 'express'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { PUBLIC_BASE_URL, LOCAL_BASE_URL } from '../config'
import { listFavorites } from '../favorites/favoritesStore'
import { SLOT_COUNT, activeEvent, eventKey, slotChannelNumber, slotName } from '../events/eventStore'
import { eventWarmSource, getWarmTarget, resolveChannel, WarmSource } from '../channels/channelStore'

// Plex (and Emby/Jellyfin) can't take an M3U playlist for Live TV — they only
// talk to network tuners. So we pretend to be an HDHomeRun: Plex reads
// /discover.json + /lineup.json, and tunes by fetching each lineup entry's URL
// expecting a continuous MPEG-TS stream. Our channels are HLS, so /auto/v<n>
// remuxes (no re-encode) through ffmpeg.
export const hdhrRouter = Router()

const TUNER_COUNT = Number(process.env.HDHR_TUNER_COUNT) || 2
// Plex identifies the tuner by DeviceID, so it has to be stable across
// restarts; derive it from the base URL unless set explicitly.
const DEVICE_ID =
  process.env.HDHR_DEVICE_ID || createHash('sha1').update(PUBLIC_BASE_URL).digest('hex').slice(0, 8).toUpperCase()
const FRIENDLY_NAME = process.env.HDHR_FRIENDLY_NAME || 'm3u-proxy'

interface LineupEntry {
  number: number
  name: string
  // Undefined for a Live Event slot with nothing on right now.
  source: () => WarmSource | undefined
}

function lineup(): LineupEntry[] {
  const entries: LineupEntry[] = [...listFavorites()]
    .sort((a, b) => (a.channelNumber ?? 0) - (b.channelNumber ?? 0))
    .map((favorite) => ({ number: favorite.channelNumber ?? 0, name: favorite.title, source: () => favorite }))
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    entries.push({
      number: slotChannelNumber(slot),
      name: slotName(slot),
      source: () => {
        const event = activeEvent(slot)
        return event ? eventWarmSource(event) : undefined
      }
    })
  }
  return entries
}

function discover() {
  return {
    FriendlyName: FRIENDLY_NAME,
    Manufacturer: 'Silicondust',
    ManufacturerURL: 'https://github.com/GoldenTundra/m3u-proxy',
    ModelNumber: 'HDTC-2US',
    FirmwareName: 'hdhomeruntc_atsc',
    FirmwareVersion: '20200101',
    DeviceID: DEVICE_ID,
    DeviceAuth: 'm3u-proxy',
    TunerCount: TUNER_COUNT,
    BaseURL: PUBLIC_BASE_URL,
    LineupURL: `${PUBLIC_BASE_URL}/lineup.json`
  }
}

hdhrRouter.get('/discover.json', (_req, res) => {
  res.json(discover())
})

hdhrRouter.get('/lineup_status.json', (_req, res) => {
  res.json({ ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] })
})

// Plex "scans" for channels during setup; there's nothing to scan.
hdhrRouter.post('/lineup.post', (_req, res) => {
  res.end()
})

hdhrRouter.get('/lineup.json', (_req, res) => {
  res.json(
    lineup().map((entry) => ({
      GuideNumber: String(entry.number),
      GuideName: entry.name,
      URL: `${PUBLIC_BASE_URL}/auto/v${entry.number}`
    }))
  )
})

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// UPnP device description; some Plex versions fetch it during discovery.
hdhrRouter.get('/device.xml', (_req, res) => {
  const d = discover()
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${escapeXml(d.BaseURL)}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${escapeXml(d.FriendlyName)}</friendlyName>
    <manufacturer>${d.Manufacturer}</manufacturer>
    <modelName>${d.ModelNumber}</modelName>
    <modelNumber>${d.ModelNumber}</modelNumber>
    <serialNumber>${d.DeviceID}</serialNumber>
    <UDN>uuid:${d.DeviceID}</UDN>
  </device>
</root>
`)
})

hdhrRouter.get('/auto/v:number', async (req, res) => {
  const entry = lineup().find((e) => String(e.number) === req.params.number)
  const source = entry?.source()
  if (!entry || !source) {
    res.status(404).end(entry ? 'No event on this slot right now' : 'Unknown channel')
    return
  }

  let target: string
  try {
    target = getWarmTarget(source.title) ?? (await resolveChannel(source))
  } catch (err) {
    console.error(`[hdhr] ${entry.name} failed:`, err)
    res.status(502).end(err instanceof Error ? err.message : 'Failed to resolve channel')
    return
  }
  // Read our own proxy over loopback rather than via the LAN address, which
  // isn't always reachable from inside the container.
  const input = target.startsWith(PUBLIC_BASE_URL) ? LOCAL_BASE_URL + target.slice(PUBLIC_BASE_URL.length) : target

  console.log(`[hdhr] Tuning ${entry.number} "${entry.name}"`)
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  ffmpeg.on('error', (err) => {
    console.error('[hdhr] Could not start ffmpeg:', err)
    if (!res.headersSent) res.status(500).end('ffmpeg is not available')
  })
  ffmpeg.stderr.on('data', (chunk: Buffer) => console.error(`[hdhr] ffmpeg: ${chunk.toString().trimEnd()}`))
  ffmpeg.on('close', () => res.end())
  res.type('video/mp2t')
  ffmpeg.stdout.pipe(res)
  // Plex closes the connection when the viewer stops watching.
  res.on('close', () => ffmpeg.kill('SIGKILL'))
})
