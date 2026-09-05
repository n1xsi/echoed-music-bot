/**
 * Standalone pipeline check — no Echoed token needed.
 *
 *   npx tsx scripts/verify-pipeline.ts "never gonna give you up"
 *
 * Verifies: yt-dlp resolves the query, the yt-dlp→ffmpeg pipe produces PCM,
 * and the byte stream slices into exactly the 20 ms stereo frames LiveKit wants.
 */

// config.ts refuses to load without a bot token; this tool never calls the API,
// so a placeholder is supplied before the dynamic imports below.
process.env['ECHOED_BOT_TOKEN'] ??= 'zbot_pipeline_verification_placeholder';

const { openPcmStream } = await import('../src/audio/pcm-stream.js');
const { resolveQuery } = await import('../src/audio/resolver.js');
const { AUDIO, config } = await import('../src/config.js');
const { formatDuration } = await import('../src/ui/embeds.js');

const query = process.argv.slice(2).join(' ') || 'kevin macleod monkeys spinning monkeys';

/** Seconds of audio to decode before declaring success. */
const TARGET_SECONDS = 6;

async function main(): Promise<void> {
  console.log(`yt-dlp:  ${config.ytdlpPath}`);
  console.log(`ffmpeg:  ${config.ffmpegPath}`);
  console.log(`format:  s16le ${AUDIO.sampleRate}Hz x${AUDIO.channels}, ${AUDIO.frameMs}ms frames`);
  console.log(`         ${AUDIO.samplesPerChannel} samples/channel, ${AUDIO.bytesPerFrame} bytes/frame\n`);

  console.log(`1. Resolving "${query}"…`);
  const started = Date.now();
  const result = await resolveQuery(query, { name: 'verify', id: 'verify' });
  const track = result.tracks[0];
  if (!track) throw new Error('resolver returned no tracks');

  console.log(`   ✓ ${track.title}`);
  console.log(`     by ${track.author} · ${formatDuration(track.duration)} · ${track.source}`);
  console.log(`     ${track.url}`);
  console.log(`     resolved in ${Date.now() - started}ms\n`);

  console.log(`2. Decoding first ${TARGET_SECONDS}s of audio…`);
  const stream = openPcmStream(track.url);
  const frameBytes = AUDIO.bytesPerFrame;
  const targetFrames = Math.ceil((TARGET_SECONDS * 1000) / AUDIO.frameMs);

  let carry: Buffer = Buffer.alloc(0);
  let frames = 0;
  let totalBytes = 0;
  let peak = 0;
  let nonSilentFrames = 0;
  const decodeStarted = Date.now();

  try {
    for await (const chunk of stream.stdout as AsyncIterable<Buffer>) {
      totalBytes += chunk.length;
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);

      let offset = 0;
      while (carry.length - offset >= frameBytes) {
        const view = carry.subarray(offset, offset + frameBytes);
        offset += frameBytes;
        frames++;

        // Same conversion the player performs.
        const samples = new Int16Array(AUDIO.samplesPerChannel * AUDIO.channels);
        for (let i = 0; i < samples.length; i++) samples[i] = view.readInt16LE(i * 2);

        let frameMax = 0;
        for (const s of samples) {
          const abs = Math.abs(s);
          if (abs > frameMax) frameMax = abs;
        }
        if (frameMax > 64) nonSilentFrames++;
        if (frameMax > peak) peak = frameMax;
      }
      carry = offset === 0 ? carry : carry.subarray(offset);

      if (frames >= targetFrames) break;
    }
  } finally {
    stream.destroy();
    await stream.closed.catch(() => undefined);
  }

  const elapsed = Date.now() - decodeStarted;
  const audioSeconds = (frames * AUDIO.frameMs) / 1000;

  console.log(`   frames:        ${frames}`);
  console.log(`   bytes:         ${totalBytes.toLocaleString()}`);
  console.log(`   audio decoded: ${audioSeconds.toFixed(2)}s in ${elapsed}ms`);
  console.log(`   peak amplitude: ${peak} / 32767`);
  console.log(`   non-silent frames: ${nonSilentFrames}/${frames}\n`);

  const problems: string[] = [];
  if (frames < targetFrames) problems.push(`only ${frames}/${targetFrames} frames decoded`);
  if (totalBytes === 0) problems.push(`ffmpeg produced no output: ${stream.errorTail().slice(0, 400)}`);
  if (peak === 0) problems.push('decoded audio is entirely silent');
  if (nonSilentFrames < frames / 2) problems.push('most frames are silent — wrong format?');

  if (problems.length > 0) {
    console.error('FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log('✓ Pipeline works: query → yt-dlp → ffmpeg → 20ms LiveKit-ready frames.');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
