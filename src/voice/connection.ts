import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

import { AUDIO } from '../config.js';
import type { EchoedClient } from '../echoed/client.js';
import { createLogger } from '../logger.js';
import { assertVoiceHostReachable, explainLiveKitFailure, parseWsEndpoint } from './reachability.js';

const log = createLogger('voice');

/**
 * Buffered ahead of the SFU. `captureFrame` blocks once this much audio is
 * queued natively, which is what paces the playback loop in real time.
 */
const QUEUE_SIZE_MS = 400;

/**
 * A live LiveKit connection publishing one audio track into an Echoed voice
 * channel. The bot API mints a 24-hour token; the actual RTC session is
 * client-side, so this owns the Room lifecycle.
 */
export class VoiceConnection {
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private closed = false;

  private constructor(
    readonly serverId: string,
    readonly channelId: string,
    private readonly api: EchoedClient,
  ) { }

  static async create(
    api: EchoedClient,
    serverId: string,
    channelId: string,
  ): Promise<VoiceConnection> {
    const connection = new VoiceConnection(serverId, channelId, api);
    await connection.connect();
    return connection;
  }

  private async connect(): Promise<void> {
    const grant = await this.api.joinVoice(this.serverId, this.channelId);
    if (!grant.success || !grant.url || !grant.token) {
      throw new Error('Echoed did not return a voice token for that channel.');
    }

    // Check the route before LiveKit does: an unreachable server surfaces as an
    // opaque "signal failure: transport timed out" ~15 s later, which hides the
    // fact that nothing is wrong with the token, the permissions, or the bot.
    await assertVoiceHostReachable(grant.url);

    const room = new Room();
    this.room = room;

    room.on(RoomEvent.Disconnected, (reason) => {
      log.warn(`room disconnected (server ${this.serverId}): ${String(reason)}`);
    });

    try {
      await room.connect(grant.url, grant.token, {
        autoSubscribe: false, // playback-only bot: no need to receive other tracks
        dynacast: true,
      });
    } catch (err) {
      const { host, port } = parseWsEndpoint(grant.url);
      throw explainLiveKitFailure(err, host, port);
    }

    const source = new AudioSource(AUDIO.sampleRate, AUDIO.channels, QUEUE_SIZE_MS);
    const track = LocalAudioTrack.createAudioTrack('music', source);
    this.source = source;
    this.track = track;

    const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
    if (!room.localParticipant) throw new Error('LiveKit room has no local participant.');
    await room.localParticipant.publishTrack(track, options);

    log.info(`joined voice channel ${this.channelId} in server ${this.serverId}`);
  }

  get isConnected(): boolean {
    return !this.closed && this.room?.isConnected === true;
  }

  /**
   * Pushes one 20 ms stereo frame. Resolves when the SFU accepts it, which
   * throttles the caller to real-time once the native queue fills.
   */
  async pushFrame(samples: Int16Array): Promise<void> {
    if (this.closed || !this.source) return;
    const frame = new AudioFrame(
      samples,
      AUDIO.sampleRate,
      AUDIO.channels,
      samples.length / AUDIO.channels,
    );
    await this.source.captureFrame(frame);
  }

  /** Drops everything still queued — used on skip/stop so audio cuts instantly. */
  clearQueue(): void {
    this.source?.clearQueue();
  }

  /** Waits for already-queued audio to finish playing out. */
  async waitForPlayout(): Promise<void> {
    await this.source?.waitForPlayout();
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      this.source?.clearQueue();
      await this.track?.close(true);
    } catch (err) {
      log.debug('track close failed:', err);
    }
    try {
      await this.room?.disconnect();
    } catch (err) {
      log.debug('room disconnect failed:', err);
    }
    this.room = null;
    this.source = null;
    this.track = null;

    // Bookkeeping only; the disconnect above is what actually leaves.
    try {
      await this.api.leaveVoice(this.serverId, this.channelId);
    } catch (err) {
      log.debug('leaveVoice bookkeeping failed:', err);
    }
    log.info(`left voice channel ${this.channelId} in server ${this.serverId}`);
  }
}
