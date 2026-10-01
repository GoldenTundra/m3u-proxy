# Keep the tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# yt-dlp-exec's preinstall runs `bin-version-check-cli python ">=2"`, which
# fails on Ubuntu/Debian images that only ship `python3`. ffmpeg remuxes HLS
# to MPEG-TS for the Plex/HDHomeRun tuner endpoint (routes/hdhr.ts).
RUN apt-get update && apt-get install -y --no-install-recommends python-is-python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY docker-entrypoint.sh /usr/local/bin/

ENV NODE_ENV=production
EXPOSE 8080
# Starts as root only to fix the data volume's ownership, then runs the
# server as the image's unprivileged `pwuser` (see docker-entrypoint.sh).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
