/**
 * Exercises the real Player against a fake voice connection: real yt-dlp,
 * real ffmpeg, real framing — only LiveKit is stubbed. No Echoed token needed.
 *
 *   npx tsx scripts/verify-player.ts
 */
process.env['ECHOED_BOT_TOKEN'] ??= 'zbot_player_verification_placeholder';

const { Player } = await import('../src/player/player.js');
const { AUDIO } = await import('../src/config.js');
type Track = import('../src/audio/resolver.js').Track;
type VoiceConnection = import('../src/voice/connection.js').VoiceConnection;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `  (${detail})`}`);
}

/** Stands in for LiveKit: counts frames and validates their shape. */
class FakeVoice {
  frames = 0;
  cleared = 0;
  destroyed = false;
  badFrames = 0;
  peak = 0;
  isConnected = true;

  async pushFrame(samples: Int16Array): Promise<void> {
    if (samples.length !== AUDIO.samplesPerChannel * AUDIO.channels) this.badFrames++;
    this.frames++;
    for (const s of samples) {
      const abs = Math.abs(s);
      if (abs > this.peak) this.peak = abs;
    }
    // Approximate LiveKit's real-time backpressure so the loop can't spin free.
    if (this.frames % 25 === 0) await new Promise((r) => setTimeout(r, 1));
  }
  clearQueue(): void {
    this.cleared++;
  }
  async waitForPlayout(): Promise<void> { }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

function makePlayer(): { player: InstanceType<typeof Player>; voice: FakeVoice } {
  const voice = new FakeVoice();
  const player = new Player(voice as unknown as VoiceConnection);
  return { player, voice };
}

/** A short, stable public-domain test track. */
const TEST_URL = 'https://www.youtube.com/watch?v=LrM_Y39Gmhk';

function testTrack(title: string): Track {
  return {
    url: TEST_URL,
    title,
    author: 'Kevin MacLeod',
    duration: 130,
    source: 'YouTube',
    isLive: false,
    requestedBy: 'verifier',
    requestedById: 'u1',
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main(): Promise<void> {
  // ── 1. plays audio and reports position ────────────────────────────────────
  console.log('\n— playback —');
  {
    const { player, voice } = makePlayer();
    const events: string[] = [];
    player.on('trackStart', (t) => events.push(`start:${t.title}`));
    player.on('playbackError', (m) => events.push(`error:${m}`));

    player.queue.push(testTrack('one'));
    player.start();

    await waitFor(() => voice.frames > 150, 60_000, 'first 150 frames');
    check('frames delivered', voice.frames > 150, `${voice.frames}`);
    check('frame size always correct', voice.badFrames === 0, `${voice.badFrames} bad`);
    check('audio is not silent', voice.peak > 1000, `peak ${voice.peak}`);
    check('state is playing', player.state === 'playing', player.state);
    check('trackStart fired', events.includes('start:one'), events.join(','));
    check('position advances', player.positionSeconds > 1, `${player.positionSeconds.toFixed(2)}s`);
    check('no errors', !events.some((e) => e.startsWith('error')), events.join(','));

    // ── 2. pause halts frame delivery ───────────────────────────────────────
    console.log('\n— pause / resume —');
    check('pause() accepted', player.pause(), player.state);
    await new Promise((r) => setTimeout(r, 400));
    const atPause = voice.frames;
    await new Promise((r) => setTimeout(r, 600));
    check('no frames while paused', voice.frames - atPause <= 1, `+${voice.frames - atPause}`);
    check('state is paused', player.state === 'paused', player.state);

    check('resume() accepted', player.resume(), player.state);
    await waitFor(() => voice.frames > atPause + 40, 15_000, 'frames after resume');
    check('frames resume', voice.frames > atPause + 40, `${voice.frames}`);

    // ── 3. volume is applied ────────────────────────────────────────────────
    console.log('\n— volume —');
    player.setVolume(0);
    voice.peak = 0;
    const beforeSilence = voice.frames;
    await waitFor(() => voice.frames > beforeSilence + 60, 15_000, 'frames at volume 0');
    check('volume 0 mutes output', voice.peak === 0, `peak ${voice.peak}`);
    player.setVolume(100);
    voice.peak = 0;
    const beforeLoud = voice.frames;
    await waitFor(() => voice.frames > beforeLoud + 60, 15_000, 'frames at volume 100');
    check('volume 100 restores audio', voice.peak > 500, `peak ${voice.peak}`);
    check('clamped to 0..200', (player.setVolume(9999), player.volume === 200), `${player.volume}`);
    player.setVolume(100);

    await player.destroy();
    check('destroy tears down voice', voice.destroyed);
  }

  // ── 4. skip is fast (the HLS teardown regression) ──────────────────────────
  console.log('\n— skip latency —');
  {
    const { player, voice } = makePlayer();
    const started: string[] = [];
    const errors: string[] = [];
    player.on('trackStart', (t) => started.push(t.title));
    player.on('playbackError', (m) => errors.push(m));

    player.queue.push(testTrack('first'), testTrack('second'));
    player.start();
    await waitFor(() => voice.frames > 60, 60_000, 'playback start');

    const t0 = Date.now();
    const framesAtSkip = voice.frames;
    check('skip() accepted', player.skip());
    await waitFor(() => started.length >= 2, 60_000, 'second track start');
    const elapsed = Date.now() - t0;

    check('advanced to next track', started[1] === 'second', started.join(','));
    check('skip took under 20s', elapsed < 20_000, `${elapsed}ms`);
    check('cleared voice queue on skip', voice.cleared > 0, `${voice.cleared}`);
    console.log(`      skip → next track in ${elapsed}ms`);

    // The skipped track must not be reported as a broken source, and the new
    // track must really deliver audio rather than only firing trackStart.
    await waitFor(() => voice.frames > framesAtSkip + 60, 60_000, 'audio after skip');
    check('second track delivers audio', voice.frames > framesAtSkip + 60, `${voice.frames}`);
    check('skip reports no bogus error', errors.length === 0, errors.join(' | ').slice(0, 120));

    // A second skip immediately during startup used to emit "returned no audio"
    // and, with listeners already detached, throw out of the pump loop.
    player.skip();
    await player.destroy();
    await new Promise((r) => setTimeout(r, 1500));
    check('teardown during startup stays quiet', errors.length === 0, errors.join(' | ').slice(0, 120));
  }

  // ── 5. queue end and stop ──────────────────────────────────────────────────
  console.log('\n— stop —');
  {
    const { player, voice } = makePlayer();
    let queueEnded = false;
    player.on('queueEnd', () => {
      queueEnded = true;
    });

    player.queue.push(testTrack('only'), testTrack('never'));
    player.start();
    await waitFor(() => voice.frames > 60, 60_000, 'playback start');

    const t0 = Date.now();
    player.stop();
    await waitFor(() => queueEnded, 30_000, 'queueEnd event');
    check('stop drains queue', player.queue.length === 0, `${player.queue.length}`);
    check('queueEnd fired', queueEnded);
    check('state returns to idle', player.state === 'idle', player.state);
    check('stop took under 20s', Date.now() - t0 < 20_000, `${Date.now() - t0}ms`);

    await player.destroy();
  }

  // ── 6. unplayable source surfaces an error, queue continues ────────────────
  console.log('\n— error handling —');
  {
    const { player, voice } = makePlayer();
    const errors: string[] = [];
    const started: string[] = [];
    player.on('playbackError', (m) => errors.push(m));
    player.on('trackStart', (t) => started.push(t.title));

    player.queue.push(
      { ...testTrack('broken'), url: 'https://example.invalid/nope.mp3' },
      testTrack('good'),
    );
    player.start();

    await waitFor(() => voice.frames > 60, 90_000, 'recovery playback');
    check('reported the bad source', errors.length > 0, `${errors.length} errors`);
    check('continued to next track', started.includes('good'), started.join(','));
    if (errors[0]) console.log(`      error surfaced: ${errors[0].split('\n')[0]}`);

    await player.destroy();
  }

  console.log(failures === 0 ? '\n✓ all player checks passed' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
