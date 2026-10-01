import type { ResolvedStream, StreamType } from './types/stream'
import { extractInfo, YtDlpFormat, YtDlpInfo } from './ytdlp'
import { scanDomForVideo } from './domScan'
import { sniffNetworkForMedia } from './networkSniff'
import { findPlayerIframeSrc } from './iframeUnwrap'
import { scanHtmlForPackedMedia } from './packerScan'

type Progress = (message: string) => void

function classify(url: string, protocol?: string): StreamType {
  if ((protocol && protocol.includes('m3u8')) || /\.m3u8(\?|$)/i.test(url)) return 'hls'
  if (/\.mpd(\?|$)/i.test(url)) return 'dash'
  return 'direct'
}

// Many CDNs reject hotlinked requests unless the Referer matches the page
// the video is embedded on — a very common anti-hotlinking pattern, not
// site-specific. DOM-scan/network-sniff results have no headers of their
// own (unlike yt-dlp's), so default to the source page's own origin.
function defaultHeaders(sourceUrl: string): Record<string, string> | undefined {
  try {
    return { Referer: new URL(sourceUrl).origin + '/' }
  } catch {
    return undefined
  }
}

function hasAudioAndVideo(f: YtDlpFormat): boolean {
  return f.vcodec !== 'none' && f.acodec !== 'none'
}

function pickFormat(info: YtDlpInfo): YtDlpFormat | undefined {
  const formats = info.formats ?? []
  const hlsFormats = formats.filter((f) => f.protocol?.includes('m3u8'))
  if (hlsFormats.length > 0) {
    return hlsFormats.find(hasAudioAndVideo) ?? hlsFormats[hlsFormats.length - 1]
  }
  const mp4 = [...formats].reverse().find((f) => f.ext === 'mp4' && f.url)
  return mp4 ?? formats[formats.length - 1]
}

const DIRECT_FILE_RE = /\.(mp4|webm|mov|mkv|m4v|avi)(\?|$)/i

async function resolveWithYtDlp(url: string): Promise<ResolvedStream | undefined> {
  try {
    const info = await extractInfo(url)
    const format = pickFormat(info)
    const rawUrl = format?.url ?? info.url
    if (!rawUrl) return undefined
    const type = classify(rawUrl, format?.protocol ?? info.protocol)
    // yt-dlp's generic extractor (used when no site-specific extractor
    // matches) can occasionally grab an unrelated link from the page and
    // guess it's a video with no real evidence (seen in the wild: a plain
    // page link with no file extension, reported as "format: 0 - unknown").
    // A named extractor is trustworthy even without a clean extension; the
    // generic one isn't unless the URL itself looks like a real video file.
    if (info.extractor_key === 'Generic' && type === 'direct' && !DIRECT_FILE_RE.test(rawUrl)) {
      return undefined
    }
    // For HLS, a single format's own `url` is often just one rendition
    // (sometimes audio-only or video-only, e.g. YouTube's adaptive itags).
    // `manifest_url` is the master playlist with proper audio/video track
    // grouping — hand that to the proxy instead so it can pick a full A/V pair.
    const streamUrl = type === 'hls' ? (format?.manifest_url ?? rawUrl) : rawUrl
    const headers = format?.http_headers ?? info.http_headers
    return {
      sourceUrl: url,
      streamUrl,
      type,
      title: info.title,
      isLive: info.is_live,
      headers
    }
  } catch {
    return undefined
  }
}

async function resolveViaDomOrSniff(
  sourceUrl: string,
  target: string,
  onProgress: Progress
): Promise<ResolvedStream | undefined> {
  // Try a plain-HTTP scan for a packed/obfuscated stream URL before ever
  // launching a browser. Some aggregator sites' anti-bot scripts detect
  // Playwright's CDP session and bail out (redirecting away) before the
  // page's video/manifest request ever fires — a bare fetch never trips
  // that check, and the URL is often sitting in the raw HTML anyway.
  onProgress('Checking page source for a packed stream URL…')
  const viaPacker = await scanHtmlForPackedMedia(target)
  if (viaPacker) {
    return {
      sourceUrl,
      streamUrl: viaPacker.url,
      type: classify(viaPacker.url),
      headers: viaPacker.headers
    }
  }

  onProgress('Scanning page for a video element…')
  const viaDom = await scanDomForVideo(target)
  if (viaDom) {
    return {
      sourceUrl,
      streamUrl: viaDom,
      type: classify(viaDom),
      headers: defaultHeaders(target),
      relayTarget: target
    }
  }

  onProgress('Sniffing network traffic for a media stream…')
  const viaSniff = await sniffNetworkForMedia(target)
  if (viaSniff) {
    return {
      sourceUrl,
      streamUrl: viaSniff,
      type: classify(viaSniff),
      headers: defaultHeaders(target),
      relayTarget: target
    }
  }

  return undefined
}

export async function resolve(url: string, onProgress: Progress): Promise<ResolvedStream> {
  onProgress('Trying yt-dlp…')
  const viaYtDlp = await resolveWithYtDlp(url)
  if (viaYtDlp) return viaYtDlp

  onProgress('Checking for an embedded player…')
  const iframeSrc = await findPlayerIframeSrc(url)
  // Resolve against the actual embedded player's own URL, not the wrapper
  // page's — see iframeUnwrap.ts for why that distinction matters. But not
  // every found iframe is the real player (could be an ad/widget), and some
  // sites have the video directly on the top-level page anyway — so if the
  // iframe path comes up empty, fall back to resolving the original page
  // rather than giving up.
  if (iframeSrc) {
    onProgress('Found an embedded player, resolving inside it…')
    const viaIframe = await resolveViaDomOrSniff(url, iframeSrc, onProgress)
    if (viaIframe) return viaIframe
  }

  const viaTopLevel = await resolveViaDomOrSniff(url, url, onProgress)
  if (viaTopLevel) return viaTopLevel

  throw new Error('Could not find a playable stream on that page.')
}
