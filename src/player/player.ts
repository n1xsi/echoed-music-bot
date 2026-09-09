import { EventEmitter } from 'node:events';

import { resolveDeferred, type Track } from '../audio/resolver.js';
import { openPcmStream, type PcmStreamHandle } from '../audio/pcm-stream.js';
import { AUDIO, config } from '../config.js';
import { createLogger } from '../logger.js';
import type { VoiceConnection } from '../voice/connection.js';
import { Queue } from './queue.js';

const log = createLogger('player');

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

export interface PlayerEvents {
  trackStart: [track: Track];
  trackEnd: [track: Track];
  queueEnd: [];
  /**
   * Deliberately not named `error`: EventEmitter throws when an `error` event
   * has no listener, so a teardown race that removes listeners first would turn
   * a recoverable bad track into a thrown exception that kills the pump loop.
   */
  playbackError: [message: string, track: Track | null];
}

/** Bytes of PCM per second — used to convert byte counts into playback time. */
const BYTES_PER_SECOND = AUDIO.sampleRate * AUDIO.channels * 2;

/**
 * Drives playback for one server: pulls PCM from ffmpeg, slices it into exact
 * 20 ms frames, applies volume, and hands frames to LiveKit. Backpressure comes
 * from `pushFrame` resolving only once the native queue has room, so the loop
 * self-paces to real time without a timer.
 */
export class Player extends EventEmitter<PlayerEvents> {
  readonly queue = new Queue();
  state: PlayerState = 'idle';
  volume: number = config.defaultVolume;

  /** Text channel that triggered playback — where "now playing" is posted. */
  textChannelId = '';

  private stream: PcmStreamHandle | null = null;
  private pumping = false;
  /** Bytes of PCM handed to LiveKit for the current track. */
  private bytesPlayed = 0;
  /** Seek offset in seconds for the current track. */
  private startOffset = 0;
  private stopRequested = false;
  private skipRequested = false;
  private resumeSignal: (() => void) | null = null;

  constructor(readonly voice: VoiceConnection) {
    super();
  }

  // ── position ──────────────────────────────────────────────────────────────

  /** Approximate playback position in seconds. */
  get positionSeconds(): number {
    return this.startOffset + this.bytesPlayed / BYTES_PER_SECOND;
  }

  get isActive(): boolean {
    return this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
  }

  // ── controls ──────────────────────────────────────────────────────────────

  /** Starts the drain loop if it isn't already running. */
  start(): void {
    if (!this.pumping) void this.pump();
  }

  pause(): boolean {
    if (this.state !== 'playing') return false;
    this.state = 'paused';
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused') return false;
    this.state = 'playing';
    this.resumeSignal?.();
    this.resumeSignal = null;
    return true;
  }

  skip(): boolean {
    if (!this.isActive) return false;
    this.skipRequested = true;
    this.state = 'playing';
    this.resumeSignal?.();
    this.resumeSignal = null;
    this.voice.clearQueue();
    this.stream?.destroy();
    return true;
  }

  stop(): void {
    this.stopRequested = true;
    this.queue.clear();
    this.queue.loop = 'off';
    this.state = 'playing';
    this.resumeSignal?.();
    this.resumeSignal = null;
    this.voice.clearQueue();
    this.stream?.destroy();
  }

  setVolume(percent: number): void {
    this.volume = Math.min(200, Math.max(0, Math.round(percent)));
  }

  /** Restarts the current track at `seconds`. */
  seek(seconds: number): boolean {
    const track = this.queue.current;
    if (!track || track.isLive) return false;
    const target = Math.max(0, Math.min(seconds, track.duration > 0 ? track.duration - 1 : seconds));
    // Re-queue the same track at the offset, then cut the current stream.
    this.pendingSeek = target;
    this.skipRequested = true;
    this.state = 'playing';
    this.resumeSignal?.();
    this.resumeSignal = null;
    this.voice.clearQueue();
    this.stream?.destroy();
    return true;
  }

  private pendingSeek: number | null = null;

  // ── main loop ─────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      for (; ;) {
        if (this.stopRequested) {
          this.stopRequested = false;
          this.queue.current = null;
          this.state = 'idle';
          this.emit('queueEnd');
          return;
        }

        let track: Track | null;
        if (this.pendingSeek !== null) {
          // Replay the current track from the seek offset.
          track = this.queue.current;
          this.startOffset = this.pendingSeek;
          this.pendingSeek = null;
        } else {
          const skipped = this.skipRequested;
          this.skipRequested = false;
          track = this.queue.next(skipped);
          this.startOffset = 0;
        }

        if (!track) {
          this.state = 'idle';
          this.emit('queueEnd');
          return;
        }

        this.state = 'loading';

        // Spotify entries and other deferred items resolve here, lazily.
        let playable: Track | null = track;
        if (track.url.startsWith('search:')) {
          try {
            playable = await resolveDeferred(track);
          } catch (err) {
            playable = null;
            log.warn(`deferred resolve failed for "${track.title}":`, describe(err));
          }
          if (!playable) {
            this.emit(
              'playbackError',
              `Could not find a playable source for **${track.title}**.`,
              track,
            );
            continue;
          }
          this.queue.current = playable;
        }

        const finished = await this.playTrack(playable);
        if (finished) this.emit('trackEnd', playable);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Returns true when the track played to its natural end. */
  private async playTrack(track: Track): Promise<boolean> {
    const stream = openPcmStream(track.url, this.startOffset);
    this.stream = stream;
    this.bytesPlayed = 0;

    // Frame-sized staging buffer: ffmpeg chunk sizes never match 20 ms exactly.
    const frameBytes = AUDIO.bytesPerFrame;
    let carry: Buffer = Buffer.alloc(0);
    let producedAudio = false;
    let naturalEnd = true;

    this.state = 'playing';
    this.emit('trackStart', track);

    try {
      for await (const chunk of stream.stdout as AsyncIterable<Buffer>) {
        producedAudio = true;
        carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);

        let offset = 0;
        while (carry.length - offset >= frameBytes) {
          if (this.stopRequested || this.skipRequested) {
            naturalEnd = false;
            break;
          }
          if (this.isPaused()) await this.waitForResume();
          if (this.stopRequested || this.skipRequested) {
            naturalEnd = false;
            break;
          }
          if (!this.voice.isConnected) {
            naturalEnd = false;
            break;
          }

          const view = carry.subarray(offset, offset + frameBytes);
          offset += frameBytes;

          // Copy into an aligned Int16Array; Buffer offsets are byte-based and
          // may not be 2-byte aligned for a direct view.
          const samples = new Int16Array(AUDIO.samplesPerChannel * AUDIO.channels);
          for (let i = 0; i < samples.length; i++) {
            samples[i] = view.readInt16LE(i * 2);
          }
          if (this.volume !== 100) applyVolume(samples, this.volume / 100);

          await this.voice.pushFrame(samples);
          this.bytesPlayed += frameBytes;
        }

        carry = offset === 0 ? carry : carry.subarray(offset);
        if (!naturalEnd) break;
      }

      // Flush a final partial frame, zero-padded, so short tracks aren't clipped.
      if (naturalEnd && carry.length > 0 && this.voice.isConnected) {
        const samples = new Int16Array(AUDIO.samplesPerChannel * AUDIO.channels);
        const usable = Math.min(carry.length - (carry.length % 2), samples.length * 2);
        for (let i = 0; i < usable / 2; i++) samples[i] = carry.readInt16LE(i * 2);
        if (this.volume !== 100) applyVolume(samples, this.volume / 100);
        await this.voice.pushFrame(samples);
        this.bytesPlayed += usable;
      }
    } catch (err) {
      naturalEnd = false;
      log.warn(`playback error on "${track.title}":`, describe(err));
    } finally {
      stream.destroy();
      await stream.closed.catch(() => undefined);
      this.stream = null;
    }

    if (!producedAudio) {
      // A deliberate teardown — skip, stop, seek, or leave — also ends the
      // stream with zero bytes decoded, and that is not a source failure.
      // `skipRequested` is still set here because pump() only consumes it when
      // it picks the next track, so this correctly covers a /skip fired during
      // the second or two a track spends starting up.
      const tornDown =
        this.stopRequested ||
        this.skipRequested ||
        this.pendingSeek !== null ||
        !this.voice.isConnected;

      if (tornDown) {
        log.debug(`"${track.title}" torn down before audio started`);
        return false;
      }

      const detail = stream.errorTail().trim();
      log.warn(`no audio decoded for ${track.url}${detail === '' ? '' : `: ${detail}`}`);
      this.emit(
        'playbackError',
        `Could not play **${track.title}** — the source returned no audio.` +
        (detail === '' ? '' : `\n\`${firstLine(detail).slice(0, 300)}\``),
        track,
      );
      return false;
    }

    // Let queued audio drain so the next track doesn't clip over the tail.
    if (naturalEnd && this.voice.isConnected) {
      await this.voice.waitForPlayout().catch(() => undefined);
    }

    return naturalEnd;
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      this.resumeSignal = resolve;
    });
  }

  /**
   * Read through a method so TypeScript doesn't narrow `state` away inside the
   * playback loop — `pause()` mutates it from outside that control flow.
   */
  private isPaused(): boolean {
    return this.state === 'paused';
  }

  async destroy(): Promise<void> {
    this.stopRequested = true;
    this.queue.clear();
    this.resumeSignal?.();
    this.resumeSignal = null;
    this.stream?.destroy();
    await this.voice.destroy();
    this.state = 'idle';
  }
}

/** In-place gain with clipping. Gain > 1 is allowed but clamps at int16 range. */
function applyVolume(samples: Int16Array, gain: number): void {
  for (let i = 0; i < samples.length; i++) {
    const scaled = Math.round((samples[i] ?? 0) * gain);
    samples[i] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? text;
}
