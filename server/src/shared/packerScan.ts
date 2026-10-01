// Some free-streaming aggregator sites hide their real stream URL behind a
// numeric-array + XOR/offset "packer": the raw HTML ships something like
// `var _x=[54,192,...]; ...eval(decode(_x))`, decoded client-side into JS
// that hands the URL to a player. The array (and the decoded URL inside it)
// is present in the plain HTTP response — no JS execution required — so a
// bare fetch recovers it without ever launching a browser. That also
// sidesteps anti-bot scripts (e.g. disable-devtool-style checks) that target
// headless-browser automation specifically and never get a chance to fire
// against a plain HTTP request.
const MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/i
const ARRAY_RE = /\[\s*\d+(?:\s*,\s*\d+){19,}\s*\]/g
const MAX_ARRAY_LEN = 20000
const MAX_ARRAYS_CHECKED = 20

function isPrintable(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)
}

// Tries every (xorKey, offset) pair, cheaply ruling most out by checking
// only a short prefix before paying for a full decode.
function tryDecodeArray(nums: number[]): string | undefined {
  const probeLen = Math.min(24, nums.length)
  for (let xorKey = 0; xorKey < 256; xorKey++) {
    for (let offset = 0; offset < 256; offset++) {
      let probeOk = true
      for (let i = 0; i < probeLen; i++) {
        const code = ((nums[i] ^ xorKey) - offset + 256) % 256
        if (!isPrintable(code)) {
          probeOk = false
          break
        }
      }
      if (!probeOk) continue

      let candidate = ''
      for (const n of nums) {
        candidate += String.fromCharCode(((n ^ xorKey) - offset + 256) % 256)
      }
      const match = candidate.match(MEDIA_URL_RE)
      if (match) return match[0]
    }
  }
  return undefined
}

export interface PackedMedia {
  url: string
  headers: Record<string, string>
}

// Some of these sites mint the stream URL's auth token bound to the request
// that fetched the page (observed: rejects the manifest fetch with "Invalid
// token" unless the User-Agent matches the one used to load the page). So
// the caller must reuse these exact headers, not a generic Referer-only set.
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
}

export async function scanHtmlForPackedMedia(url: string): Promise<PackedMedia | undefined> {
  const referer = (() => {
    try {
      return new URL(url).origin + '/'
    } catch {
      return url
    }
  })()
  const headers = { ...FETCH_HEADERS, Referer: referer }

  let html: string
  try {
    const res = await fetch(url, { headers })
    html = await res.text()
  } catch {
    return undefined
  }

  const arrayMatches = html.match(ARRAY_RE)
  if (!arrayMatches) return undefined

  for (const raw of arrayMatches.slice(0, MAX_ARRAYS_CHECKED)) {
    const nums = raw
      .slice(1, -1)
      .split(',')
      .map((s) => Number(s.trim()))
    if (nums.length > MAX_ARRAY_LEN) continue
    const found = tryDecodeArray(nums)
    if (found) return { url: found, headers }
  }

  return undefined
}
