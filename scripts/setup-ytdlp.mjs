#!/usr/bin/env node
/**
 * Downloads the latest yt-dlp binary into ./bin.
 *
 * yt-dlp updates constantly to keep up with site changes, so it's fetched at
 * setup time (and re-runnable) rather than pinned as an npm dependency.
 */
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'bin');

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

function assetName() {
    switch (platform()) {
        case 'win32':
            return { remote: 'yt-dlp.exe', local: 'yt-dlp.exe' };
        case 'darwin':
            return { remote: 'yt-dlp_macos', local: 'yt-dlp' };
        default:
            return { remote: 'yt-dlp', local: 'yt-dlp' };
    }
}

async function download(url, dest, redirects = 5) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function main() {
    const { remote, local } = assetName();
    const dest = path.join(BIN_DIR, local);

    await mkdir(BIN_DIR, { recursive: true });

    console.log(`Downloading ${remote} → ${path.relative(ROOT, dest)}`);
    await download(`${RELEASES}/${remote}`, dest);

    const { size } = await stat(dest);
    if (size < 1_000_000) {
        throw new Error(`Downloaded file is only ${size} bytes — likely not the real binary.`);
    }

    if (platform() !== 'win32') await chmod(dest, 0o755);

    console.log(`Done — ${(size / 1_048_576).toFixed(1)} MB`);
    console.log('\nyt-dlp needs no Python runtime (these builds are self-contained).');
    console.log('ffmpeg comes from the bundled ffmpeg-static package.');
}

main().catch((err) => {
    console.error('\nSetup failed:', err.message);
    console.error(
        '\nWorkaround: install yt-dlp yourself (https://github.com/yt-dlp/yt-dlp#installation)\n' +
        'and point YTDLP_PATH at it in .env.',
    );
    process.exit(1);
});

