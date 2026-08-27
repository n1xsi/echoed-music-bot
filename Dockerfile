# Runs the bot outside a network that blocks Echoed's voice server.
#
# Debian rather than Alpine on purpose: @livekit/rtc-node ships prebuilt native
# binaries linked against glibc, and they will not load under musl.

FROM node:22-bookworm-slim

# ca-certificates for TLS to Echoed, yt-dlp and the audio sources. ffmpeg comes
# from the ffmpeg-static package, and yt-dlp's Linux build is a self-contained
# PyInstaller bundle, so neither needs a system package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached across source edits.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Downloads the Linux yt-dlp build into ./bin. Done at build time so a container
# start never depends on GitHub being reachable.
RUN npm run setup && npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
