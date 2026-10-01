// Input checks for the admin API. Page URLs end up as yt-dlp arguments and
// headless-browser navigations, and titles/tvg fields are written into the
// M3U and XMLTV output, so both are constrained here at the edge.

const MAX_TEXT_LENGTH = 200

// Only http(s) — no file:, data:, javascript:, or anything that isn't a URL.
export function parseHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

// One line of plain text: control characters (incl. CR/LF, which would
// start a new M3U line) become spaces. Empty -> undefined.
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH)
  return text || undefined
}

// For values inside an M3U attribute (`tvg-name="…"`), which has no escape
// syntax: drop the quote. Also re-cleans data saved before validation existed.
export function m3uAttr(value: string): string {
  return (cleanText(value) ?? '').replace(/"/g, "'")
}
