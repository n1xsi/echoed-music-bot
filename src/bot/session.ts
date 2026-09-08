import type { Track } from '../audio/resolver.js';
import { config } from '../config.js';
import type { EchoedClient } from '../echoed/client.js';
import { createLogger } from '../logger.js';
import { Player } from '../player/player.js';
import { errorEmbed, nowPlayingEmbed } from '../ui/embeds.js';
import { VoiceConnection } from '../voice/connection.js';

const log = createLogger('session');

/**
 * One active music session per server: a voice connection, a player, and the
 * live "now playing" message.
 */
export class Session {
  readonly player: Player;
  private nowPlayingMessageId: string | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  private constructor(
    readonly serverId: string,
    readonly voiceChannelId: string,
    private readonly api: EchoedClient,
    private readonly onDestroy: (serverId: string) => void,
    voice: VoiceConnection,
  ) {
    this.player = new Player(voice);
    this.wirePlayer();
  }

  static async create(
    api: EchoedClient,
    serverId: string,
    voiceChannelId: string,
    textChannelId: string,
    onDestroy: (serverId: string) => void,
  ): Promise<Session> {
    const voice = await VoiceConnection.create(api, serverId, voiceChannelId);
    const session = new Session(serverId, voiceChannelId, api, onDestroy, voice);
    session.player.textChannelId = textChannelId;
    return session;
  }

  private wirePlayer(): void {
    this.player.on('trackStart', (track) => {
      this.clearIdleTimer();
      void this.postNowPlaying(track);
    });

    this.player.on('playbackError', (message) => {
      void this.say(errorEmbed(message));
    });

    this.player.on('queueEnd', () => {
      this.stopProgressUpdates();
      this.nowPlayingMessageId = null;
      this.startIdleTimer();
    });
  }

  // ── now playing message ───────────────────────────────────────────────────

  private async postNowPlaying(track: Track): Promise<void> {
    this.stopProgressUpdates();
    const embed = nowPlayingEmbed(track, this.player.positionSeconds, {
      paused: this.player.state === 'paused',
      loop: this.player.queue.loop,
      volume: this.player.volume,
      queueLength: this.player.queue.length,
    });

    try {
      const sent = await this.api.sendEmbed(this.serverId, this.player.textChannelId, embed);
      this.nowPlayingMessageId = sent.id;
    } catch (err) {
      log.warn('failed to post now-playing:', describe(err));
      this.nowPlayingMessageId = null;
      return;
    }

    // Live progress bar via message edits, which Echoed broadcasts as
    // message:updated so clients re-render in place. Needs the message id, so
    // say so rather than ticking a timer that can only return early.
    if (!config.nowPlayingProgress || track.isLive) return;
    if (this.nowPlayingMessageId === null) {
      log.warn('no message id for the now-playing embed; progress bar disabled for this track');
      return;
    }

    this.progressTimer = setInterval(() => {
      void this.refreshNowPlaying();
    }, config.nowPlayingIntervalMs);
    this.progressTimer.unref?.();
  }

  /** Re-renders the now-playing embed in place. */
  async refreshNowPlaying(): Promise<void> {
    const track = this.player.queue.current;
    const messageId = this.nowPlayingMessageId;
    if (!track || messageId === null || this.destroyed) return;
    if (this.player.state === 'idle') return;

    const embed = nowPlayingEmbed(track, this.player.positionSeconds, {
      paused: this.player.state === 'paused',
      loop: this.player.queue.loop,
      volume: this.player.volume,
      queueLength: this.player.queue.length,
    });

    try {
      await this.api.editMessage(this.serverId, messageId, { embeds: [embed] });
    } catch (err) {
      // Message deleted or no longer editable — stop trying.
      log.debug('now-playing edit failed:', describe(err));
      this.stopProgressUpdates();
    }
  }

  private stopProgressUpdates(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // ── idle handling ─────────────────────────────────────────────────────────

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (config.idleDisconnectMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.player.isActive) return;
      log.info(`idle timeout in server ${this.serverId}, leaving voice`);
      void this.say(errorEmbed('Left the voice channel after being idle.')).catch(() => undefined);
      void this.destroy();
    }, config.idleDisconnectMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async say(embed: Parameters<EchoedClient['sendEmbed']>[2]): Promise<void> {
    try {
      await this.api.sendEmbed(this.serverId, this.player.textChannelId, embed);
    } catch (err) {
      log.warn('failed to send message:', describe(err));
    }
  }

  get isVoiceAlive(): boolean {
    return this.player.voice.isConnected;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopProgressUpdates();
    this.clearIdleTimer();
    // Detach before destroying so the shutdown itself can't post "left because
    // idle" or track-end chatter into the channel we are walking away from.
    this.player.removeAllListeners();
    await this.player.destroy();
    this.onDestroy(this.serverId);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
