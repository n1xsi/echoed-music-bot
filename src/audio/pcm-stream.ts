import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { AUDIO, config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('stream');

export interface PcmStreamHandle {
  /** Raw s16le / 48 kHz / stereo chunks. */
  stdout: NodeJS.ReadableStream;
  /** Kills both processes. Safe to call repeatedly. */
  destroy(): void;
  /** Resolves once both processes have exited. */
  closed: Promise<void>;
  /** ffmpeg/yt-dlp stderr tail, for error reporting. */
  errorTail(): string;
}

/**
 * Builds `yt-dlp <url> -o -` piped into `ffmpeg` that decodes to the exact PCM
 * format LiveKit's AudioSource expects.
 *
 * Piping through yt-dlp (rather than handing ffmpeg a `-g` direct URL) keeps
 * playback working on sites with expiring URLs, HLS/DASH manifests, and
 * per-request auth — yt-dlp owns the network side, ffmpeg only decodes.
 */
export function openPcmStream(url: string, startSeconds = 0): PcmStreamHandle {
  const ytdlpArgs = [
    '--no-warnings',
    '--ignore-config',
    '--no-playlist',
    // bestaudio first; fall back to any format with audio for sites that
    // only publish muxed streams.
    '--format',
    'bestaudio[acodec!=none]/bestaudio/best[acodec!=none]/best',
    '--no-part',
    '--no-progress',
    // Retry transient network failures inside yt-dlp rather than dropping out.
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    '--output',
    '-',
  ];
  if (config.ytdlpCookieFile !== '') ytdlpArgs.push('--cookies', config.ytdlpCookieFile);
  else if (config.ytdlpCookiesFromBrowser !== '')
    ytdlpArgs.push('--cookies-from-browser', config.ytdlpCookiesFromBrowser);
  ytdlpArgs.push(url);

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    // Input seek must precede -i to be fast.
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i',
    'pipe:0',
    '-vn',
    '-f',
    's16le',
    '-ar',
    String(AUDIO.sampleRate),
    '-ac',
    String(AUDIO.channels),
    // Normalise wildly different source levels a little without pumping.
    '-af',
    'aresample=async=1:first_pts=0',
    'pipe:1',
  ];

  log.debug(`yt-dlp ${url} | ffmpeg → s16le ${AUDIO.sampleRate}Hz x${AUDIO.channels}`);

  const ytdlp = spawn(config.ytdlpPath, ytdlpArgs, { windowsHide: true });
  const ffmpeg = spawn(config.ffmpegPath, ffmpegArgs, { windowsHide: true });

  let stderrTail = '';
  const collect = (source: 'yt-dlp' | 'ffmpeg') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + `[${source}] ${text}`).slice(-4000);
    log.debug(`${source}: ${text.trim()}`);
  };
  ytdlp.stderr.on('data', collect('yt-dlp'));
  ffmpeg.stderr.on('data', collect('ffmpeg'));

  ytdlp.stdout.pipe(ffmpeg.stdin);

  // EPIPE is expected whenever we kill ffmpeg mid-download; swallow it.
  const ignore = (label: string) => (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
    log.debug(`${label} stream error: ${err.message}`);
  };
  ytdlp.stdout.on('error', ignore('yt-dlp stdout'));
  ffmpeg.stdin.on('error', ignore('ffmpeg stdin'));

  let spawnError: string | null = null;
  const onSpawnError = (label: string) => (err: NodeJS.ErrnoException) => {
    spawnError =
      err.code === 'ENOENT'
        ? `${label} not found. Run "npm run setup" (yt-dlp) or set FFMPEG_PATH / YTDLP_PATH.`
        : `${label}: ${err.message}`;
    log.error(spawnError);
  };
  ytdlp.on('error', onSpawnError(`yt-dlp (${config.ytdlpPath})`));
  ffmpeg.on('error', onSpawnError(`ffmpeg (${config.ffmpegPath})`));

  const closed = Promise.all([once(ytdlp), once(ffmpeg)]).then(() => undefined);

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    // Kill yt-dlp first: if ffmpeg dies while yt-dlp is still downloading, the
    // broken stdout pipe makes yt-dlp retry the in-flight fragment ten times
    // with backoff, which stalls teardown for minutes on HLS sources.
    killTree(ytdlp);
    // Unpipe so the dying downloader can't push into ffmpeg's stdin.
    ytdlp.stdout.unpipe(ffmpeg.stdin);
    ffmpeg.stdin.destroy();
    killTree(ffmpeg);
  };

  return {
    stdout: ffmpeg.stdout,
    destroy,
    closed,
    errorTail: () => spawnError ?? stderrTail,
  };
}

/**
 * Terminates a child and everything it spawned.
 *
 * `yt-dlp.exe` is a PyInstaller one-file bundle: the process Node spawns is a
 * bootstrap that re-execs the real interpreter as a child. Killing only the
 * parent leaves that worker downloading in the background, so on Windows the
 * whole tree is killed via taskkill.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;

  if (process.platform === 'win32' && pid !== undefined) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => child.kill('SIGKILL'));
      return;
    } catch {
      // Fall through to the plain kill below.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Resolves when the child exits, or after `timeoutMs` regardless. The cap keeps
 * a wedged process from stalling the player's track transition.
 */
function once(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
  });
}
