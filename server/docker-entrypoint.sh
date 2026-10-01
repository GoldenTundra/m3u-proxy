#!/bin/sh
set -e
# The server runs as the unprivileged `pwuser`, so Chromium (which loads
# arbitrary third-party pages) never runs as root. Bind-mounted data dirs
# are usually created root-owned by Docker, so hand ownership over first.
DATA_DIR="${DATA_DIR:-${YTDLP_DATA_DIR:-/data/bin}}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R pwuser:pwuser "$DATA_DIR"
  exec setpriv --reuid=pwuser --regid=pwuser --init-groups "$@"
fi
exec "$@"
