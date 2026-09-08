import { spawn } from 'node:child_process';

import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ytdlp');

export interface YtDlpEntry {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  artist?: string;
  creator?: string;
  track?: string;
  thumbnail?: string;
  extractor_key?: string;
  extractor?: string;
  is_live?: boolean;
  live_status?: string;
  playlist_count?: number;
  _type?: string;
  entries?: YtDlpEntry[];
}

export class YtDlpError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'YtDlpError';
  }
}

/** Extra flags applied to every yt-dlp invocation. */
function baseArgs(): string[] {
  const args = [
    '--no-warnings',
    '--ignore-config',
    '--no-playlist-reverse',
    // Some extractors abort the whole run on one bad entry otherwise.
    '--ignore-errors',
  ];
  if (config.ytdlpCookieFile !== '') args.push('--cookies', config.ytdlpCookieFile);
  else if (config.ytdlpCookiesFromBrowser !== '')
    args.push('--cookies-from-browser', config.ytdlpCookiesFromBrowser);
  return args;
}

/**
 * Runs yt-dlp and returns stdout. Rejects with YtDlpError on a non-zero exit.
 */
export function runYtDlp(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = [...baseArgs(), ...args];
    log.debug('yt-dlp', full.join(' '));

    const child = spawn(config.ytdlpPath, full, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new YtDlpError(`yt-dlp timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new YtDlpError(
            `yt-dlp not found at "${config.ytdlpPath}". Run "npm run setup" or set YTDLP_PATH.`,
            stderr,
          ),
        );
        return;
      }
      reject(new YtDlpError(err.message, stderr));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // With --ignore-errors yt-dlp exits non-zero yet still emits usable JSON
      // for entries it did resolve, so stdout is trusted when it holds real
      // objects. A hard failure prints a bare "null" — sometimes even with exit
      // code 0 — so the stderr reason is surfaced instead of a vague "no results".
      if (hasJsonObject(stdout)) {
        resolve(stdout);
        return;
      }
      const reason = firstErrorLine(stderr);
      if (reason !== null) {
        reject(new YtDlpError(reason, stderr));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
    });
  });
}

/** True when stdout holds at least one JSON object (not just "null" lines). */
function hasJsonObject(stdout: string): boolean {
  return stdout.split('\n').some((line) => line.trim().startsWith('{'));
}

/** Parses yt-dlp's `-J`/`--dump-json` output, which may be one JSON object per line. */
export function parseJsonLines(stdout: string): YtDlpEntry[] {
  const out: YtDlpEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as YtDlpEntry);
    } catch {
      // Truncated line — skip it.
    }
  }
  return out;
}

function firstErrorLine(stderr: string): string | null {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('ERROR:')) return trimmed.replace(/^ERROR:\s*/, '');
  }
  const fallback = stderr.trim().split('\n')[0];
  return fallback === undefined || fallback === '' ? null : fallback;
}

export async function ytDlpVersion(): Promise<string> {
  const out = await runYtDlp(['--version'], 20_000);
  return out.trim();
}
