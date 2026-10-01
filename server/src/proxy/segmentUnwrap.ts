// Some stream sites host their MPEG-TS segments on free image CDNs by
// disguising them as images: e.g. served as `image/webp`, with a 42-byte
// fake RIFF/WEBP header prepended to otherwise-genuine MPEG-TS. Their own player strips the
// prefix client-side; a plain HLS client (Channels DVR) can't, so we do it.
//
// Rather than hard-coding one site's prefix length, find the first offset
// where the TS sync byte (0x47) repeats at the 188-byte packet stride.
const TS_PACKET_SIZE = 188
const TS_SYNC_BYTE = 0x47
const SYNC_PACKETS_REQUIRED = 5
const MAX_PREFIX_BYTES = 4096

function findTsStart(body: Buffer): number {
  const limit = Math.min(MAX_PREFIX_BYTES, body.length - TS_PACKET_SIZE * SYNC_PACKETS_REQUIRED)
  for (let i = 0; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < SYNC_PACKETS_REQUIRED; k++) {
      if (body[i + k * TS_PACKET_SIZE] !== TS_SYNC_BYTE) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

// Returns the segment unchanged unless it's a disguised TS payload.
export function unwrapSegment(body: Buffer, contentType: string): { body: Buffer; contentType: string } {
  if (!/^image\//i.test(contentType)) return { body, contentType }
  const start = findTsStart(body)
  if (start < 0) return { body, contentType }
  return { body: body.subarray(start), contentType: 'video/mp2t' }
}
