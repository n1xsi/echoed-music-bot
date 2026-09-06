import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import ffmpegStatic from 'ffmpeg-static';

dotenv.config();

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(key: string, fallback: number): number {
  const raw = str(key);
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = str(key).toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** `yt-dlp` on POSIX, `yt-dlp.exe` on Windows. */
export const YTDLP_BINARY_NAME = platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

/** Where `npm run setup` puts the downloaded binary. */
export const YTDLP_DEFAULT_PATH = path.join(PROJECT_ROOT, 'bin', YTDLP_BINARY_NAME);

function resolveYtDlp(): string {
  const explicit = str('YTDLP_PATH');
  if (explicit !== '') return explicit;
  if (existsSync(YTDLP_DEFAULT_PATH)) return YTDLP_DEFAULT_PATH;
  // Fall back to a PATH lookup — the user may have yt-dlp installed globally.
  return YTDLP_BINARY_NAME;
}

function resolveFfmpeg(): string {
  const explicit = str('FFMPEG_PATH');
  if (explicit !== '') return explicit;
  // ffmpeg-static ships ESM-style .d.ts for a CJS module, so TS types the
  // default import as the module namespace while Node hands us the path string.
  // It is null on platforms with no prebuilt binary.
  const bundled = ffmpegStatic as unknown as string | null;
  return bundled ?? 'ffmpeg';
}

const token = str('ECHOED_BOT_TOKEN');
if (token === '') {
  console.error(
    'ECHOED_BOT_TOKEN is not set.\n' +
    'Copy .env.example to .env and paste the bot key from Echoed → Settings → Bot Profile.',
  );
  process.exit(1);
}
if (!token.startsWith('zbot_')) {
  console.warn(`[config] ECHOED_BOT_TOKEN does not start with "zbot_" — is it the right key?`);
}

export const config = {
  botToken: token,
  apiBase: str('ECHOED_API_BASE', 'https://go.echoed.gg/v1/bots').replace(/\/+$/, ''),
  socketUrl: str('ECHOED_SOCKET_URL', 'https://socket.echoed.gg').replace(/\/+$/, ''),

  prefix: str('COMMAND_PREFIX', '/'),
  defaultVoiceChannel: str('DEFAULT_VOICE_CHANNEL'),
  defaultVolume: Math.min(200, Math.max(0, int('DEFAULT_VOLUME', 100))),

  nowPlayingProgress: bool('NOW_PLAYING_PROGRESS', true),
  // Anything under ~5s burns the 120 req/min budget for no visible gain.
  nowPlayingIntervalMs: Math.max(5000, int('NOW_PLAYING_INTERVAL_MS', 10_000)),

  idleDisconnectMs: Math.max(0, int('IDLE_DISCONNECT_MS', 300_000)),
  maxPlaylistTracks: Math.min(500, Math.max(1, int('MAX_PLAYLIST_TRACKS', 100))),

  ytdlpPath: resolveYtDlp(),
  ffmpegPath: resolveFfmpeg(),
  ytdlpCookiesFromBrowser: str('YTDLP_COOKIES_FROM_BROWSER'),
  ytdlpCookieFile: str('YTDLP_COOKIE_FILE'),

  logLevel: str('LOG_LEVEL', 'info'),
} as const;

/**
 * Audio format required by LiveKit's AudioSource. Echoed's docs specify
 * 48 kHz / 2 channels / 20 ms frames for bot voice publishing.
 */
export const AUDIO = {
  sampleRate: 48_000,
  channels: 2,
  frameMs: 20,
  /** 960 samples per channel at 48 kHz / 20 ms. */
  get samplesPerChannel(): number {
    return (this.sampleRate * this.frameMs) / 1000;
  },
  /** Int16 stereo: 2 bytes per sample per channel. */
  get bytesPerFrame(): number {
    return this.samplesPerChannel * this.channels * 2;
  },
} as const;
