import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, copyFileSync, mkdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { DATA_DIR } from '../config'

const execFileAsync = promisify(execFile)

function bundledBinaryPath(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return join(__dirname, '../../node_modules/yt-dlp-exec/bin', binName)
}


function persistedBinaryPath(): string {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return join(DATA_DIR, binName)
}

export async function ensureYtDlpInstalled(): Promise<string> {
  const target = persistedBinaryPath()
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(bundledBinaryPath(), target)
    chmodSync(target, 0o755)
  }
  return target
}

export async function selfUpdate(): Promise<string> {
  const bin = await ensureYtDlpInstalled()
  const { stdout, stderr } = await execFileAsync(bin, ['-U'])
  return stdout || stderr
}

export interface YtDlpFormat {
  url: string
  manifest_url?: string
  protocol?: string
  ext?: string
  vcodec?: string
  acodec?: string
  http_headers?: Record<string, string>
}

export interface YtDlpInfo {
  url?: string
  protocol?: string
  ext?: string
  is_live?: boolean
  title?: string
  http_headers?: Record<string, string>
  formats?: YtDlpFormat[]
  extractor_key?: string
}

export async function extractInfo(url: string): Promise<YtDlpInfo> {
  const bin = await ensureYtDlpInstalled()
  const { stdout } = await execFileAsync(
    bin,
    // `--` so a "URL" starting with a dash can never be read as an option
    // (some, like --netrc-cmd, run arbitrary commands).
    ['--dump-json', '--no-playlist', '--no-warnings', '--', url],
    { maxBuffer: 20 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}
