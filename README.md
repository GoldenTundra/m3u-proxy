# m3u-proxy

Turn web pages that play live TV into real channels for **Channels DVR**,
**Plex Live TV & DVR**, or any IPTV app that takes an M3U playlist, with
real program guide data.

You give it a page URL (a channel's live stream page, say) and a name. It
finds the actual video stream on that page, keeps it ready, and serves it
as a normal channel with a pinned channel number, a logo, and an XMLTV guide.

```
 web page with a player ──► m3u-proxy ──► playlist.m3u + guide.xml ──► Channels DVR / IPTV apps
                                     └──► HDHomeRun-style tuner     ──► Plex
```

## Features

- **Stream resolver.** Tries [yt-dlp] first, then falls back to a headless
  Chromium that unwraps embedded player iframes, scans the page, and sniffs
  network traffic for `.m3u8`/video URLs. Pages behind a JS challenge, or
  CDNs that only answer real browsers, are handled with an in-browser relay.
- **Pre-warmed channels.** Every channel is resolved in the background
  (on startup, when added, and every 30 minutes), so tuning in is instant.
  A cold resolve can take ~20s, longer than most DVR tuners wait.
- **Stream proxy.** HLS playlists and segments are re-served through the
  proxy with the headers the upstream CDN expects, so signed or expiring
  URLs never reach your DVR.
- **Real guide data.** Pick a channel from the [iptv-org] catalog in the
  admin page and the proxy grabs its listings from tvguide.com (US
  channels) and serves them as XMLTV. Unmapped channels get a "Live
  Programming" placeholder so they're always tunable.
- **Live Event slots.** Three fixed channels (2500–2502) for one-off games:
  assign a URL and start time, and the guide shows "Up next…", then the
  matchup (padded for overtime, never with scores), then clears itself.
- **Stable channel numbers.** Channels are numbered from 2000 and keep their
  number forever, so removing one never renumbers the rest.
- **Channels DVR auto-refresh** (optional). When you change channels or
  events, the proxy tells Channels DVR to re-read the guide right away.
- **Plex support.** Emulates an HDHomeRun network tuner and remuxes streams
  to MPEG-TS with ffmpeg (no re-encoding).

## Requirements

- Docker with Docker Compose (Linux, macOS with Docker Desktop/OrbStack, or
  a NAS that runs Compose). `amd64` and `arm64` both work.
- About 1 GB of free RAM, plus 300–500 MB for each headless browser running
  at once. Most channels only need the browser briefly while being resolved.
- A machine that's always on, on the same network as your DVR.
- For Plex: a Plex Pass (Plex requires one for Live TV & DVR).

## Install

```bash
git clone https://github.com/GoldenTundra/m3u-proxy.git
cd m3u-proxy
cp .env.example .env
```

Edit `.env` and set `PUBLIC_BASE_URL` to **this machine's LAN IP** and port:

```bash
PUBLIC_BASE_URL=http://192.168.1.20:9090
```

Don't use `localhost` or `127.0.0.1`. Your DVR fetches streams from this
address over the network, so it has to work from another machine. (To find
the IP, run `ipconfig getifaddr en0` on macOS or `hostname -I` on Linux.)

Then start it:

```bash
docker compose up -d --build
```

The first build takes a few minutes (it pulls a Playwright/Chromium base
image). Check it's up:

```bash
curl http://192.168.1.20:9090/healthz      # {"ok":true}
```

Open `http://<your-ip>:9090` in a browser to get the admin page.

### Configuration

All settings go in `.env`. Only `PUBLIC_BASE_URL` is required.

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | *(required)* | LAN address your DVR uses to reach the proxy, e.g. `http://192.168.1.20:9090`. |
| `HOST_PORT` | `9090` | Host port to publish. Keep `PUBLIC_BASE_URL`'s port in sync. |
| `TZ` | `America/New_York` | Timezone for guide text like "Up next: …, 7:00 PM". |
| `CHANNELS_DVR_URL` | *(off)* | Your Channels DVR server, e.g. `http://192.168.1.10:8089`, to refresh its guide automatically. |
| `HDHR_TUNER_COUNT` | `2` | How many channels Plex may stream/record at once. |
| `HDHR_FRIENDLY_NAME` | `m3u-proxy` | Tuner name shown in Plex. |
| `HDHR_DEVICE_ID` | *(derived)* | 8 hex chars identifying the tuner to Plex. Set it if you run two instances, or plan to change `PUBLIC_BASE_URL`. |

Data (your channels, events, and the yt-dlp binary) lives in
`./volumes/ytdlp-bin/`. Back that folder up; nothing else is stateful.

## Adding channels

1. Open the admin page, `http://<your-ip>:9090`.
2. Under **Add a channel**, start typing the channel name (e.g. `CNN`). Pick
   the match from the dropdown to get guide data and a logo. You can also
   just type any name to make a channel without a guide.
3. Paste the URL of the page where the stream plays and click **Save**.
4. Within about 30 seconds the **Warm** column should show ✓. If it shows ✗,
   the resolver couldn't find a stream on that page; check the logs
   (`docker compose logs -f`) and try a different page.

Use ✎ to change a channel's URL later (when a site moves, say) while keeping
its number and guide mapping.

**Live events** (the second tab): choose a slot, give the game a title, URL,
start time, and sport. The slot starts warming 10 minutes before start time.

## Connecting your DVR

The admin page's **Setup** panel shows every URL below, with Copy buttons.

### Channels DVR

1. In Channels DVR, go to **Settings → Sources → Add Source → Custom
   Channels**.
2. Set **Stream Format** to **HLS**.
3. **Source URL:** `http://<your-ip>:9090/playlist.m3u`
4. **XMLTV Guide Data:** `http://<your-ip>:9090/guide.xml`. Refreshing
   every 6 hours (or more often) is a good choice.
5. Save. Channels show up at 2000+ and Live Event slots at 2500–2502.

Optional: set `CHANNELS_DVR_URL=http://<dvr-ip>:8089` in `.env` and run
`docker compose up -d`. From then on, adding or removing a channel or
event refreshes Channels DVR's lineup and guide within seconds, instead of
whenever its next scheduled refresh happens. (This uses Channels DVR's local,
undocumented API. If it ever stops working, everything else still works, just
with slower guide updates.)

### Plex

Plex can't load an M3U playlist for Live TV, only network tuners, so the
proxy pretends to be an **HDHomeRun** tuner.

1. In Plex Web, go to **Settings → Live TV & DVR → Set Up Plex DVR**.
2. Plex probably won't find it on its own (Docker networking blocks the
   discovery broadcast). Click **"Don't see your HDHomeRun device? Enter
   its network address manually"** and enter `<your-ip>:9090`, for example
   `192.168.1.20:9090`.
3. A device called **m3u-proxy** appears. Click **Continue**. When Plex
   says it found channels, continue again.
4. On the guide step, choose **"Have an XMLTV guide on your server? Click
   here to use that instead"** and enter:
   `http://<your-ip>:9090/plex/guide.xml`
   (Plex has its own guide URL, keyed by channel number so Plex can match
   channels automatically.)
5. Check the channel mapping. Each tuner channel (`2000`, `2001`, …) should
   be matched to the guide channel with the same number. Then click
   **Continue**.

Notes for Plex:

- Each channel someone is watching or recording runs one ffmpeg process.
  `HDHR_TUNER_COUNT` caps how many run at once.
- **After adding or removing channels**, Plex won't see them until you go to
  **Settings → Live TV & DVR → (your m3u-proxy device) → Scan for channels**
  and update the mapping. Guide data refreshes on Plex's own schedule; use
  **Refresh guide** in the same place to force it.
- If Plex runs in Docker on the same machine, still use the LAN IP, not
  `localhost`.

Emby and Jellyfin can use either method: add `playlist.m3u` as an M3U
tuner with `guide.xml`, or add the HDHomeRun tuner at `<your-ip>:9090`
with `plex/guide.xml`.

### Other IPTV apps

Anything that takes an M3U URL and an XMLTV URL (TiviMate, iPlayTV, VLC,
etc.) can use `playlist.m3u` and `guide.xml` directly.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /` | Admin page. |
| `GET /playlist.m3u` | M3U playlist (Channels DVR / IPTV apps). |
| `GET /guide.xml` | XMLTV guide, keyed by `tvg-id`. |
| `GET /plex/guide.xml` | XMLTV guide, keyed by channel number (Plex). |
| `GET /channel/:title`, `GET /slot/:n` | Tune a channel / Live Event slot (redirects to the HLS proxy). |
| `GET /discover.json`, `/lineup.json`, `/lineup_status.json`, `/device.xml` | HDHomeRun emulation (Plex). |
| `GET /auto/v:number` | Tune by channel number as MPEG-TS (Plex). |
| `GET /stream/:session/...` | The HLS/stream proxy itself. |
| `GET /healthz` | Health check. |
| `/api/favorites`, `/api/events`, `/api/catalog/search` | JSON API used by the admin page. |

## How it works

- **Resolving.** `server/src/shared/resolver.ts` tries yt-dlp, then loads
  the page in headless Chromium (Playwright). There it looks for a player
  iframe to follow, scans the DOM and packed scripts for media URLs, and
  watches network requests for an HLS manifest.
- **Warming.** `server/src/channels/channelStore.ts` resolves every
  channel ahead of time, 3 at a time, and refreshes them every 30 minutes.
  Resolved URLs are often signed and expire, so they're never written into
  the playlist. The playlist points at a stable `/channel/<title>` URL that
  redirects to whatever's warm right now.
- **Proxying.** `server/src/proxy/` rewrites HLS manifests so every
  playlist, key, and segment goes back through the proxy with the right
  headers. If a CDN rejects anything that isn't a real browser,
  `server/src/shared/browserRelay.ts` runs those fetches inside a headless
  page instead.
- **Guide.** `server/src/guide/` maps channels against iptv-org's free
  catalog and grabs listings from tvguide.com once a day.
- **Plex.** `server/src/routes/hdhr.ts` serves the HDHomeRun API and pipes
  each tuned channel through `ffmpeg -c copy -f mpegts`.

## Troubleshooting

- **A channel won't warm (✗).** Run `docker compose logs -f` and look for
  `[channel] Failed to warm "<name>"`. The page may have changed, gone
  offline, or put the stream behind a login. Try opening it in a normal
  browser first.
- **Channels DVR: "timeout awaiting response headers".** The channel
  wasn't warm yet. Wait for ✓ in the admin page and tune again.
- **Plex can't connect to the tuner.** Make sure `curl
  http://<your-ip>:9090/discover.json` works *from the Plex server's
  machine*, and that `BaseURL` in its output is reachable from there too
  (it comes from `PUBLIC_BASE_URL`).
- **Plex plays nothing, or stops right away.** Check the logs for `[hdhr]
  ffmpeg:` errors. The usual cause is a channel that isn't warm yet, or a
  stream that died.
- **No guide data.** Only channels picked from the catalog dropdown get
  real listings, and only for channels tvguide.com covers (mostly US cable
  networks). The first grab after adding a channel takes a minute or two.
- **Guide times are off by hours.** Set `TZ` in `.env` to your timezone.
- **Log says "Chromium sandbox unavailable on this host".** Everything
  still works, but pages load in Chromium without its sandbox. This happens
  when your Docker host doesn't allow the user namespaces the sandbox needs
  (some NAS models, older kernels, or Ubuntu hosts that restrict them with
  AppArmor). Keep the `security_opt` line in `docker-compose.yml`. It's
  what normally makes the sandbox work.

## Known limitations

- DASH (`.mpd`) streams aren't supported, only HLS and direct video files.
- Sites change all the time. When a page changes its player, the resolver
  may stop finding the stream until you update that channel's URL.
- Guide data comes from tvguide.com, so it's mostly limited to US channels.
- There's no authentication. **Run it only on a trusted home network**,
  and never port-forward it to the internet: the API can make the server
  open any URL in a browser.

## Security

Resolving streams means loading arbitrary third-party pages, many of them
ad-heavy, in a headless browser. To limit the damage if one of them
attacks the browser:

- The server runs as an unprivileged user (`pwuser`), not root. The
  container only starts as root long enough to give that user ownership of
  the data folder.
- Chromium runs with its sandbox on. The included seccomp profile
  (`server/seccomp_profile.json`, Playwright's official one) allows the
  sandbox inside Docker; on hosts that don't support it, the server logs a
  warning and runs without it.
- Page URLs must be `http(s)` and are passed to yt-dlp after `--`, so they
  can never be read as command-line options. Titles and guide fields are
  cleaned before they go into the playlist and guide.

Found a security problem? Please open a GitHub issue, or for anything
sensitive, use GitHub's private vulnerability reporting on this repo.

## Development

```bash
cd server
npm install
npx playwright install chromium     # first time only
PUBLIC_BASE_URL=http://localhost:8080 DATA_DIR=./.data npm run dev
```

`npx tsc --noEmit` type-checks. The admin page is plain HTML/JS in
`server/src/public/`. The Plex endpoint needs `ffmpeg` on your `PATH`.

## Legal

This is a general-purpose tool, like yt-dlp. You're responsible for making
sure you have the right to access and record whatever you point it at, and
for following the terms of the sites you use. The authors don't host,
provide, or link to any content.

## Credits

- [yt-dlp] for stream extraction.
- [iptv-org] for the free channel/logo catalog. The tvguide.com grabber is
  adapted from [iptv-org/epg] (released under the Unlicense).
- [Playwright] for headless Chromium.

## License

[MIT](LICENSE)

[yt-dlp]: https://github.com/yt-dlp/yt-dlp
[iptv-org]: https://github.com/iptv-org/iptv
[iptv-org/epg]: https://github.com/iptv-org/epg
[Playwright]: https://playwright.dev
