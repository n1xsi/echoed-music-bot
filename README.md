# Echoed Music Bot

A music bot for [Echoed](https://echoed.gg) that plays audio from **900+ sites** —
YouTube, SoundCloud, Bandcamp, Yandex Music, VK, Twitch, Vimeo, Mixcloud, direct
MP3/FLAC links, and anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp)
supports.

```
/play never gonna give you up
/play https://soundcloud.com/artist/track
/play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
```

Built in TypeScript on Echoed's documented bot stack: the REST API for messages,
the Socket.IO gateway for events, and LiveKit for voice.

---

## Setup

Requires **Node.js 20.11+**.

```bash
npm install          # dependencies (ffmpeg ships bundled)
npm run setup        # downloads yt-dlp into ./bin
cp .env.example .env # then paste your bot key into it
npm run dev
```

Get the bot key from Echoed: **Settings → Developers → create a bot**. It starts
with `zbot_`. Invite the bot to a server, then make sure it has permission to
read messages, send messages, and connect to voice.

```env
ECHOED_BOT_TOKEN=zbot_your_key_here
```

`.env.example` documents every other option; all of them have working defaults.

For production, `npm run build && npm run serve`.

---

## Installing the bot on a server

Echoed gates the Bot API behind review. Until the bot is approved, every request
returns:

```
403 bot_not_approved — Bots must pass review before they can use the API,
or be added to a server with a development invite token.
```

Three install paths exist, and the invite links used for user accounts are not
one of them — a bot cannot join by invite link.

### 1. Development token (easiest, works before approval)

In the web client, open the server → **Server Settings → Bots**. Two buttons sit
at the top right: the bright accent one opens the bot browser (approved bots
only), and the **pale outlined button to its left** opens a dialog that takes the
`edev_` development token directly. Paste it, and a consent screen shows the
bot's name, avatar and requested permissions with checkboxes.

The same flow from the terminal, when that button is unavailable:

```bash
npm run install-bot
```

It needs `DEV_INVITE_TOKEN`, `ECHOED_USER_JWT` and `SERVER_ID` in `.env`, all
documented in `.env.example`.

> **Tick the voice permissions.** The consent screen offers exactly the
> permissions the bot asks for. A bot that requests none falls back to a list
> that contains no `CONNECT` or `SPEAK`, so it would be installed unable to join
> voice at all. Set the requested set first in **Settings → Bot Profile**:
> `VIEW_CHANNELS`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`, `EMBED_LINKS`,
> `CONNECT`, `SPEAK`, `USE_VOICE_ACTIVITY`.

Neither the dialog's endpoints nor the `edev_` token appear in the developer
docs. They were read out of the web client's own bundle
(`assets/botService-*.js` on `beta.echoed.gg`), so they are unofficial:

```
POST /v1/bots/dev-token/preview        { token }
     → { botId, name, avatar, requestedPermissions }
POST /v1/bots/{serverId}/invite/token  { token, grantedPermissions, acknowledgeRisk }
```

Both authenticate with the *session JWT of a human* holding `MANAGE_SERVER` —
not with the `zbot_` key.

### 2. OAuth2 (the documented path)

```bash
npm run invite
```

| Variable | Where from |
| --- | --- |
| `OAUTH_CLIENT_ID` | **Your own** account → Settings → OAuth2 Apps → register a client |
| `OAUTH_CLIENT_SECRET` | same app |
| `BOT_ID` | the bot's *user id*, not the `zbot_` key |

Register the client under your own account, not the bot's: a bot account cannot
use regular endpoints, and the app acts as *you*. Inviting is something a human
with bot-management permission does; the bot is only the thing being invited.
Stay logged in as yourself when the browser opens for approval.

Register `http://localhost:8787/callback` as the app's redirect URI, exactly.
The script then opens your browser for approval, catches the callback on that
port, exchanges the code for a token, lists the servers you may add bots to, and
posts `POST /oauth2/api/servers/{id}/invite-bot`.

`BOT_ID` is the catch: both endpoints that return it (`/validate` and
`/profile`) are themselves behind the approval gate, so the id is unreachable
until the bot is already installed. `npm run install-bot` prints it while
resolving the dev token.

### 3. Bot Discovery

The bot browser in a server's Bots tab. Lists approved bots only, so this one
works after review.

Whichever path you take, confirm it landed:

```bash
npm run check
```

That prints the bot's identity, every server it is installed on, the channels it
can see, and whether `/play` will work there without `/join` first.

> Renaming the bot or changing its avatar or description returns it to the review
> queue automatically, which re-locks the API.

---

## Two things worth knowing before you use it

**1. The bot cannot see which voice channel you're in.** Echoed's bot API exposes
no way to read a member's voice state, so unlike Discord bots this one can't
follow you into a channel. Tell it where to go once:

```
/join Music
```

After that `/play` works normally. To skip that step permanently, set
`DEFAULT_VOICE_CHANNEL=Music` in `.env`. If a server has exactly one voice
channel, the bot picks it automatically. `/channels` lists what it can see.

**2. Spotify links resolve by matching, not streaming.** Spotify audio is DRM
protected and cannot be streamed by any third-party bot. Spotify URLs are read
for their metadata (title, artist, playlist contents), then each track is matched
against YouTube. Playlists resolve lazily — one match per track, at the moment it
starts playing — so a 100-track playlist queues instantly.

---

## Commands

Default prefix is `/`, configurable via `COMMAND_PREFIX`.

| Command | Aliases | What it does |
| --- | --- | --- |
| `/play <name or URL>` | `/p` | Queue a track, playlist, album, or search phrase |
| `/playnext <name or URL>` | `/pn` | Queue it directly after the current track |
| `/join [channel]` | `/summon` | Connect to a voice channel |
| `/leave` | `/stop`, `/disconnect`, `/dc` | Stop and disconnect |
| `/skip` | `/s` | Skip the current track |
| `/pause` | | Pause playback |
| `/resume` | `/unpause` | Resume playback |
| `/queue [page]` | `/q` | Show the queue |
| `/nowplaying` | `/np` | Re-post the now-playing embed |
| `/volume [0-200]` | `/vol` | Show or set volume |
| `/loop [off\|track\|queue]` | `/repeat` | Cycle or set loop mode |
| `/shuffle` | | Shuffle the upcoming tracks |
| `/remove <position>` | `/rm` | Remove one queued track |
| `/move <from> <to>` | | Reorder the queue |
| `/clear` | | Empty the queue, keep playing |
| `/seek <time>` | | Jump to `90`, `1:30`, or `1:02:03` |
| `/channels` | | List voice channels the bot can join |
| `/help` | `/commands` | Command reference |

Unrecognised commands are ignored silently, so this bot can share a `/` prefix
with others in the same server.

---

## How it works

```
/play query
   ↓  yt-dlp                 search or resolve → track metadata
   ↓  yt-dlp | ffmpeg        download → decode to s16le 48kHz stereo
   ↓  Player                 slice into exact 20 ms / 3840-byte frames, apply volume
   ↓  LiveKit AudioSource    publish as a microphone track
```

A few decisions that aren't obvious from the code:

**yt-dlp owns the network, ffmpeg only decodes.** Audio is piped
`yt-dlp -o - | ffmpeg` instead of handing ffmpeg a direct URL. That keeps
playback working on sites with expiring URLs, HLS/DASH manifests, and per-request
auth, and it's why the platform list is as long as it is.

**Playback paces itself with no timer.** LiveKit's `captureFrame()` resolves only
once its native queue has room, so awaiting it throttles the read loop to real
time. There is no `setInterval` anywhere in the audio path.

**Teardown kills yt-dlp before ffmpeg.** The reverse order leaves yt-dlp writing
into a broken pipe, which makes it retry the in-flight fragment ten times with
backoff — `/skip` on an HLS source would hang for minutes. Because `yt-dlp.exe`
is a PyInstaller bundle that re-execs its real worker as a child process, Windows
teardown goes through `taskkill /T /F` to kill the whole tree. Measured skip
latency is ~150 ms.

**The rate limiter is shared and serialised.** Echoed allows 120 requests/minute;
the client spaces every call 500 ms apart and honours `retryAfter` on 429
globally, so a burst of commands can't get the bot throttled. This is also why
`NOW_PLAYING_INTERVAL_MS` defaults to 10000 and is floored at 5000 — the live
progress bar is a message edit, and each edit spends a request.

---

## Verification

Three suites, none of which need an Echoed token:

```bash
npx tsx scripts/verify-logic.ts     # 51 pure-logic checks — parser, queue, formatting
npx tsx scripts/verify-pipeline.ts  # real query → yt-dlp → ffmpeg → LiveKit-ready frames
npx tsx scripts/verify-player.ts    # real Player: playback, pause, volume, skip, errors
```

`verify-player.ts` stubs only LiveKit; everything else is the real pipeline,
including that a fast `/skip` doesn't post a bogus error and that a broken source
does.

---

## Troubleshooting

**"Echoed's voice server is unreachable from the machine running this bot"** —
this is a blocked route, not a bug, and not a permission problem. Echoed splits
its infrastructure: the REST API (`go.echoed.gg`) and the gateway
(`socket.echoed.gg`) sit behind Cloudflare, while voice — LiveKit *and* TURN,
across `livekit.zoriumapp.com`, `livekit.echoed.gg` and `turn.echoed.gg` — all
resolve to one bare address, `198.23.177.190`, with no Cloudflare in front and
no alternative hostname. A network that drops traffic to that single address
leaves a bot that authenticates, lists channels, answers commands and even
appears in the voice member list, but never carries audio.

Confirm which side is at fault with:

```bash
npm run check
```

That asks Echoed for a real voice grant and then tests whether the address it
points at answers. If the grant succeeds and the TCP handshake gets no reply,
the block is on the host's network. Russian ISPs are a known case: the trace
dies at the first upstream hop while external probes reach the same address in
under 300 ms.

There are only two fixes, because there is no second hostname to fall back to
and proxying the signal socket would not help — WebRTC media goes to the same
address:

- give the machine a route to it, with a VPN;
- or run the bot somewhere else, which is the better answer for a bot that
  should be up 24/7 anyway (see below).

A VPN only counts if it operates at the network layer — TUN mode, or whatever the
client calls a full tunnel. A client running as a *system proxy* does not help
here however reliably it works in a browser: Node's raw sockets ignore the proxy
settings, and WebRTC media is UDP, which a proxy cannot carry at all. The symptom
is a VPN that is plainly connected while the bot still cannot reach voice. Check
which one you have:

```bash
netstat -rn | grep "^ *0.0.0.0"     # the 0.0.0.0/0 gateway must be the tunnel
```

If that route points at your physical router, the tunnel is not carrying the
bot's traffic.

**"yt-dlp not found"** — run `npm run setup`, or set `YTDLP_PATH` to an existing
binary.

**"Sign in to confirm you're not a bot"** — YouTube is rate-limiting the host.
Set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `firefox`, `edge`) in `.env`, or
point `YTDLP_COOKIE_FILE` at an exported cookies file.

**Bot joins but no audio** — check the bot has voice permission in that channel,
and run with `LOG_LEVEL=debug` to see the yt-dlp/ffmpeg stderr.

**"I don't know which voice channel to join"** — see note 1 above: `/join <name>`
or set `DEFAULT_VOICE_CHANNEL`.

**Audio cuts out on long tracks** — usually the source throttling the download.
`--retries 5 --fragment-retries 10` is already set; persistent cases are worth a
`LOG_LEVEL=debug` run to confirm.

**The gateway reconnects every couple of minutes** — expected, and harmless.
Echoed's Socket.IO connection dies on its own after anywhere from ~50 s to
~170 s; measured against the live gateway, the more the bot sends the sooner it
happens (heartbeats every 10 s → dead at ~45 s, every 30 s → ~80 s, none →
~155 s). Nothing client-side prevents it. What the bot does control is how fast
it notices: Socket.IO alone waits out `pingInterval + pingTimeout` = 45 s, during
which the bot looks connected and silently drops every command. A watchdog in
`gateway.ts` treats an unanswered heartbeat (normally acked in ~170 ms) or 32 s
of total silence as death and reconnects immediately, which cuts the dead window
to a few seconds.

---

## Running it on a server

The one real fix for a blocked voice route, and the right home for a bot anyway.
Verify the host can actually reach voice *before* trusting it — from the server:

```bash
npm run check
```

### With Docker

```bash
docker build -t echoed-music-bot .
docker run -d --restart unless-stopped --env-file .env --name music echoed-music-bot
```

The image bundles yt-dlp and ffmpeg, so the host needs nothing but Docker.

### Without Docker

Needs Node.js 20.11+ only; ffmpeg comes from npm and yt-dlp is downloaded by
`npm run setup`.

```bash
sudo useradd --system --home /opt/echoed-music-bot music
sudo git clone <your-repo> /opt/echoed-music-bot
cd /opt/echoed-music-bot
npm ci                     # devDependencies included — the build needs tsc
npm run setup              # yt-dlp into ./bin
npm run build

sudo install -m 600 -o music -g music .env /opt/echoed-music-bot/.env
sudo chown -R music:music /opt/echoed-music-bot
sudo cp deploy/echoed-music-bot.service /etc/systemd/system/
sudo systemctl enable --now echoed-music-bot
sudo journalctl -u echoed-music-bot -f
```

`.env` is deliberately not in the repository. Copy it across by hand — it holds
the `zbot_` token — and keep it at mode 600.

One caveat worth knowing: a datacenter IP makes YouTube demand verification much
sooner than a home connection does. If tracks start failing with *"Sign in to
confirm you're not a bot"*, supply cookies via `YTDLP_COOKIE_FILE` as described
above.

---

## Layout

```
src/
  index.ts              entrypoint, dependency checks, signal handling
  config.ts             env parsing, audio format constants
  echoed/
    client.ts           rate-limited REST client
    gateway.ts          Socket.IO gateway with 30s heartbeat
    types.ts            API payload types
  audio/
    resolver.ts         query/URL → Track, Spotify matching
    pcm-stream.ts       yt-dlp | ffmpeg → PCM, and its teardown
    ytdlp.ts            process wrapper and error extraction
  voice/connection.ts   LiveKit room + published audio track
  player/
    player.ts           the frame loop
    queue.ts            queue and loop modes
  bot/
    music-bot.ts        command dispatch
    session.ts          per-server state, live now-playing message
    parser.ts           command and channel-name parsing
  ui/embeds.ts          embed rendering, progress bar
```

