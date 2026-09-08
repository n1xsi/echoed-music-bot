import { resolveQuery, type Track } from '../audio/resolver.js';
import { config } from '../config.js';
import { EchoedClient } from '../echoed/client.js';
import { EchoedGateway } from '../echoed/gateway.js';
import type { EchoedChannel, EchoedEmbed, EchoedMessage } from '../echoed/types.js';
import { createLogger } from '../logger.js';
import type { LoopMode } from '../player/queue.js';
import {
  errorEmbed,
  formatDuration,
  infoEmbed,
  playlistEmbed,
  queueEmbed,
  queuedEmbed,
} from '../ui/embeds.js';
import { VoiceHostUnreachableError, VoiceTransportError } from '../voice/reachability.js';
import { findChannel, isVoiceChannel, parseCommand } from './parser.js';
import { Session } from './session.js';

const log = createLogger('bot');

const QUEUE_PAGE_SIZE = 10;
/** Channel lists change rarely; cache them to save API budget. */
const CHANNEL_CACHE_TTL_MS = 60_000;

interface CommandContext {
  serverId: string;
  channelId: string;
  userId: string;
  userName: string;
  args: string;
  argv: string[];
}

export class MusicBot {
  private readonly api = new EchoedClient();
  private readonly gateway = new EchoedGateway();
  private readonly sessions = new Map<string, Session>();
  /** Server → last `/join` target, so /play knows where to go. */
  private readonly preferredVoice = new Map<string, string>();
  private readonly channelCache = new Map<string, { at: number; channels: EchoedChannel[] }>();
  private botUserId = '';
  private shuttingDown = false;

  async start(): Promise<void> {
    const validation = await this.api.validate();
    if (!validation.valid) throw new Error('Echoed rejected the bot token.');
    this.botUserId = validation.bot_id;

    const profile = await this.api.getProfile().catch(() => null);
    log.info(`authenticated as ${profile?.username ?? this.botUserId} (${this.botUserId})`);

    const servers = await this.api.listServers().catch(() => []);
    log.info(`present in ${servers.length} server(s)`);

    this.gateway.on('messageCreate', (message) => {
      void this.onMessage(message).catch((err) => log.error('message handler failed:', err));
    });
    this.gateway.connect();
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('shutting down');
    this.gateway.close();
    await Promise.allSettled([...this.sessions.values()].map((s) => s.destroy()));
    this.sessions.clear();
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  private async onMessage(message: EchoedMessage): Promise<void> {
    // Without this guard every reply the bot posts re-triggers the handler.
    if (message.senderId === this.botUserId) return;
    if (message.author?.isBot === true) return;
    if (!message.serverId || !message.channelId) return;

    const parsed = parseCommand(message.content ?? '', config.prefix);
    if (!parsed) return;

    const ctx: CommandContext = {
      serverId: message.serverId,
      channelId: message.channelId,
      userId: message.senderId,
      userName: message.author?.name ?? 'someone',
      args: parsed.args,
      argv: parsed.argv,
    };

    log.debug(`command "${parsed.name}" from ${ctx.userName} in ${ctx.serverId}`);

    try {
      await this.dispatch(parsed.name, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(`command "${parsed.name}" failed:`, detail);
      await this.reply(ctx, errorEmbed(detail || 'Something went wrong running that command.'));
    }
  }

  private async dispatch(name: string, ctx: CommandContext): Promise<void> {
    switch (name) {
      case 'play':
      case 'p':
        return this.cmdPlay(ctx, false);
      case 'playnext':
      case 'pn':
        return this.cmdPlay(ctx, true);
      case 'join':
      case 'summon':
        return this.cmdJoin(ctx);
      case 'leave':
      case 'stop':
      case 'disconnect':
      case 'dc':
        return this.cmdLeave(ctx);
      case 'skip':
      case 's':
        return this.cmdSkip(ctx);
      case 'pause':
        return this.cmdPause(ctx);
      case 'resume':
      case 'unpause':
        return this.cmdResume(ctx);
      case 'queue':
      case 'q':
        return this.cmdQueue(ctx);
      case 'nowplaying':
      case 'np':
        return this.cmdNowPlaying(ctx);
      case 'volume':
      case 'vol':
        return this.cmdVolume(ctx);
      case 'loop':
      case 'repeat':
        return this.cmdLoop(ctx);
      case 'shuffle':
        return this.cmdShuffle(ctx);
      case 'remove':
      case 'rm':
        return this.cmdRemove(ctx);
      case 'move':
        return this.cmdMove(ctx);
      case 'clear':
        return this.cmdClear(ctx);
      case 'seek':
        return this.cmdSeek(ctx);
      case 'channels':
        return this.cmdChannels(ctx);
      case 'help':
      case 'commands':
        return this.cmdHelp(ctx);
      default:
        return; // Not our command — stay quiet so other bots can respond.
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────

  private async cmdPlay(ctx: CommandContext, playNext: boolean): Promise<void> {
    if (ctx.args === '') {
      await this.reply(
        ctx,
        infoEmbed(`Usage: \`${config.prefix}play <track name or link>\``, 'What should I play?'),
      );
      return;
    }

    const session = await this.ensureSession(ctx);
    if (!session) return;

    const busy = await this.reply(ctx, infoEmbed(`🔎 Searching for \`${trim(ctx.args, 120)}\`…`));

    let result;
    try {
      result = await resolveQuery(ctx.args, { name: ctx.userName, id: ctx.userId });
    } catch (err) {
      await this.replaceOrSend(
        ctx,
        busy,
        errorEmbed(err instanceof Error ? err.message : 'Could not resolve that query.'),
      );
      return;
    }

    if (result.tracks.length === 0) {
      await this.replaceOrSend(ctx, busy, errorEmbed('No results for that query.'));
      return;
    }

    const { player } = session;
    player.textChannelId = ctx.channelId;
    const wasIdle = !player.isActive;

    if (playNext && result.tracks.length === 1 && result.tracks[0]) {
      player.queue.pushNext(result.tracks[0]);
    } else {
      player.queue.push(...result.tracks);
    }

    const embed =
      result.tracks.length > 1
        ? playlistEmbed(
          result.playlistTitle ?? 'Playlist',
          result.tracks,
          result.truncated,
          wasIdle ? 1 : player.queue.length - result.tracks.length + 1,
        )
        : queuedEmbed(result.tracks[0] as Track, playNext ? 1 : player.queue.length);

    // When idle the "now playing" card follows immediately, so skip the
    // redundant "added to queue" card for a single track.
    if (wasIdle && result.tracks.length === 1) {
      await this.deleteIfPossible(ctx.serverId, busy);
    } else {
      await this.replaceOrSend(ctx, busy, embed);
    }

    player.start();
  }

  private async cmdJoin(ctx: CommandContext): Promise<void> {
    const channels = await this.getChannels(ctx.serverId);
    const voiceChannels = channels.filter(isVoiceChannel);

    if (voiceChannels.length === 0) {
      await this.reply(ctx, errorEmbed('This server has no voice channels.'));
      return;
    }

    let target: EchoedChannel | null = null;
    if (ctx.args !== '') {
      target = findChannel(voiceChannels, ctx.args);
      if (!target) {
        await this.reply(
          ctx,
          errorEmbed(
            `No voice channel matching \`${trim(ctx.args, 60)}\`.\n` +
            `Available: ${voiceChannels.map((c) => `\`${c.name}\``).join(', ')}`,
          ),
        );
        return;
      }
    } else {
      target = this.defaultVoiceChannel(voiceChannels);
      if (!target) {
        await this.reply(
          ctx,
          infoEmbed(
            `Tell me which channel to join: \`${config.prefix}join <name>\`\n` +
            `Available: ${voiceChannels.map((c) => `\`${c.name}\``).join(', ')}`,
            'Which voice channel?',
          ),
        );
        return;
      }
    }

    const existing = this.sessions.get(ctx.serverId);
    if (existing && existing.voiceChannelId === target.id && existing.isVoiceAlive) {
      await this.reply(ctx, infoEmbed(`Already in **${target.name}**.`));
      return;
    }
    if (existing) await existing.destroy();

    this.preferredVoice.set(ctx.serverId, target.id);
    const session = await this.openSession(ctx, target.id);
    if (!session) return;

    await this.reply(ctx, infoEmbed(`Joined **${target.name}**.`, 'Connected'));
  }

  private async cmdLeave(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed("I'm not in a voice channel here."));
      return;
    }
    await session.destroy();
    await this.reply(ctx, infoEmbed('Stopped playback and left the voice channel.'));
  }

  private async cmdSkip(ctx: CommandContext): Promise<void> {
    const session = this.requireSession(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed('Nothing is playing.'));
      return;
    }
    const current = session.player.queue.current;
    if (!session.player.skip()) {
      await this.reply(ctx, errorEmbed('Nothing is playing.'));
      return;
    }
    await this.reply(ctx, infoEmbed(`⏭ Skipped **${current?.title ?? 'the track'}**.`));
  }

  private async cmdPause(ctx: CommandContext): Promise<void> {
    const session = this.requireSession(ctx.serverId);
    if (!session || !session.player.pause()) {
      await this.reply(ctx, errorEmbed('Nothing is playing.'));
      return;
    }
    await this.reply(ctx, infoEmbed('⏸ Paused.'));
    await session.refreshNowPlaying();
  }

  private async cmdResume(ctx: CommandContext): Promise<void> {
    const session = this.requireSession(ctx.serverId);
    if (!session || !session.player.resume()) {
      await this.reply(ctx, errorEmbed('Playback is not paused.'));
      return;
    }
    await this.reply(ctx, infoEmbed('▶ Resumed.'));
    await session.refreshNowPlaying();
  }

  private async cmdQueue(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, infoEmbed('The queue is empty. Add something with `/play`.', 'Queue'));
      return;
    }
    const page = Number.parseInt(ctx.argv[0] ?? '1', 10);
    const { player } = session;
    await this.reply(
      ctx,
      queueEmbed(player.queue.current, player.positionSeconds, player.queue.upcoming, {
        loop: player.queue.loop,
        page: Number.isFinite(page) ? page : 1,
        pageSize: QUEUE_PAGE_SIZE,
        totalDuration: player.queue.totalDuration,
      }),
    );
  }

  private async cmdNowPlaying(ctx: CommandContext): Promise<void> {
    const session = this.requireSession(ctx.serverId);
    const track = session?.player.queue.current;
    if (!session || !track) {
      await this.reply(ctx, errorEmbed('Nothing is playing.'));
      return;
    }
    const { player } = session;
    await this.reply(
      ctx,
      (await import('../ui/embeds.js')).nowPlayingEmbed(track, player.positionSeconds, {
        paused: player.state === 'paused',
        loop: player.queue.loop,
        volume: player.volume,
        queueLength: player.queue.length,
      }),
    );
  }

  private async cmdVolume(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed("I'm not in a voice channel here."));
      return;
    }
    if (ctx.args === '') {
      await this.reply(ctx, infoEmbed(`Volume is **${session.player.volume}%**.`));
      return;
    }
    const value = Number.parseInt(ctx.args, 10);
    if (!Number.isFinite(value) || value < 0 || value > 200) {
      await this.reply(ctx, errorEmbed('Give a volume between 0 and 200.'));
      return;
    }
    session.player.setVolume(value);
    await this.reply(ctx, infoEmbed(`🔊 Volume set to **${value}%**.`));
  }

  private async cmdLoop(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed("I'm not in a voice channel here."));
      return;
    }

    const raw = (ctx.argv[0] ?? '').toLowerCase();
    const modes: Record<string, LoopMode> = {
      off: 'off',
      none: 'off',
      track: 'track',
      song: 'track',
      one: 'track',
      queue: 'queue',
      all: 'queue',
    };

    let mode = modes[raw];
    if (mode === undefined) {
      // No argument: cycle off → track → queue → off.
      const cycle: LoopMode[] = ['off', 'track', 'queue'];
      const index = cycle.indexOf(session.player.queue.loop);
      mode = cycle[(index + 1) % cycle.length] ?? 'off';
    }

    session.player.queue.loop = mode;
    const label = mode === 'off' ? 'disabled' : mode === 'track' ? '🔂 looping track' : '🔁 looping queue';
    await this.reply(ctx, infoEmbed(`Loop ${label}.`));
    await session.refreshNowPlaying();
  }

  private async cmdShuffle(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session || session.player.queue.length < 2) {
      await this.reply(ctx, errorEmbed('Need at least 2 queued tracks to shuffle.'));
      return;
    }
    session.player.queue.shuffle();
    await this.reply(ctx, infoEmbed(`🔀 Shuffled ${session.player.queue.length} track(s).`));
  }

  private async cmdRemove(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed('The queue is empty.'));
      return;
    }
    const position = Number.parseInt(ctx.argv[0] ?? '', 10);
    if (!Number.isFinite(position)) {
      await this.reply(ctx, errorEmbed(`Usage: \`${config.prefix}remove <position>\``));
      return;
    }
    const removed = session.player.queue.remove(position);
    if (!removed) {
      await this.reply(ctx, errorEmbed(`No track at position ${position}.`));
      return;
    }
    await this.reply(ctx, infoEmbed(`🗑 Removed **${removed.title}**.`));
  }

  private async cmdMove(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session) {
      await this.reply(ctx, errorEmbed('The queue is empty.'));
      return;
    }
    const from = Number.parseInt(ctx.argv[0] ?? '', 10);
    const to = Number.parseInt(ctx.argv[1] ?? '', 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      await this.reply(ctx, errorEmbed(`Usage: \`${config.prefix}move <from> <to>\``));
      return;
    }
    if (!session.player.queue.move(from, to)) {
      await this.reply(ctx, errorEmbed('Those positions are not in the queue.'));
      return;
    }
    await this.reply(ctx, infoEmbed(`↕ Moved track ${from} → ${to}.`));
  }

  private async cmdClear(ctx: CommandContext): Promise<void> {
    const session = this.sessions.get(ctx.serverId);
    if (!session || session.player.queue.length === 0) {
      await this.reply(ctx, errorEmbed('The queue is already empty.'));
      return;
    }
    const count = session.player.queue.length;
    session.player.queue.clear();
    await this.reply(ctx, infoEmbed(`🗑 Cleared ${count} queued track(s).`));
  }

  private async cmdSeek(ctx: CommandContext): Promise<void> {
    const session = this.requireSession(ctx.serverId);
    if (!session || !session.player.queue.current) {
      await this.reply(ctx, errorEmbed('Nothing is playing.'));
      return;
    }
    const seconds = parseTimestamp(ctx.args);
    if (seconds === null) {
      await this.reply(ctx, errorEmbed(`Usage: \`${config.prefix}seek 1:23\` or \`${config.prefix}seek 83\``));
      return;
    }
    if (!session.player.seek(seconds)) {
      await this.reply(ctx, errorEmbed('This track cannot be seeked (live stream?).'));
      return;
    }
    await this.reply(ctx, infoEmbed(`⏩ Seeking to \`${formatDuration(seconds)}\`…`));
  }

  private async cmdChannels(ctx: CommandContext): Promise<void> {
    const channels = await this.getChannels(ctx.serverId);
    const voice = channels.filter(isVoiceChannel);
    const text = channels.filter((c) => !isVoiceChannel(c));
    const format = (list: EchoedChannel[]) =>
      list.length === 0 ? '_none_' : list.map((c) => `\`${c.name}\` — \`${c.id}\``).join('\n');

    await this.reply(ctx, {
      type: 'rich',
      title: 'Channels',
      description: `**Voice**\n${format(voice)}\n\n**Other**\n${format(text)}`,
      color: 0xffc928,
      footer: { text: `Use ${config.prefix}join <name> to connect` },
    });
  }

  private async cmdHelp(ctx: CommandContext): Promise<void> {
    const p = config.prefix;
    await this.reply(ctx, {
      type: 'rich',
      title: 'Music commands',
      description:
        'Plays from YouTube, SoundCloud, Bandcamp, Vimeo, Twitch, Spotify links ' +
        '(matched on YouTube) and ~900 other sites via yt-dlp.',
      color: 0xffc928,
      fields: [
        {
          name: 'Playback',
          value: [
            `\`${p}play <name|link>\` — queue a track, playlist or album`,
            `\`${p}playnext <name|link>\` — queue at the front`,
            `\`${p}pause\` · \`${p}resume\` · \`${p}skip\``,
            `\`${p}seek <1:23>\` · \`${p}volume <0-200>\``,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Queue',
          value: [
            `\`${p}queue [page]\` · \`${p}nowplaying\``,
            `\`${p}shuffle\` · \`${p}clear\``,
            `\`${p}remove <n>\` · \`${p}move <from> <to>\``,
            `\`${p}loop [off|track|queue]\``,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Voice',
          value: [
            `\`${p}join [channel]\` — connect to a voice channel`,
            `\`${p}leave\` — stop and disconnect`,
            `\`${p}channels\` — list channels and ids`,
          ].join('\n'),
          inline: false,
        },
      ],
      footer: {
        text: 'Echoed cannot report which voice channel you are in, so use /join first (or set DEFAULT_VOICE_CHANNEL).',
      },
    });
  }

  // ── session helpers ───────────────────────────────────────────────────────

  /** Returns a live session, dropping one whose voice link has dropped. */
  private requireSession(serverId: string): Session | null {
    const session = this.sessions.get(serverId);
    if (!session) return null;
    if (!session.isVoiceAlive) {
      void session.destroy();
      return null;
    }
    return session;
  }

  /** Gets or creates the session for /play, resolving the voice channel. */
  private async ensureSession(ctx: CommandContext): Promise<Session | null> {
    const existing = this.sessions.get(ctx.serverId);
    if (existing) {
      if (existing.isVoiceAlive) {
        existing.player.textChannelId = ctx.channelId;
        return existing;
      }
      await existing.destroy();
    }

    const channels = await this.getChannels(ctx.serverId);
    const voiceChannels = channels.filter(isVoiceChannel);
    if (voiceChannels.length === 0) {
      await this.reply(ctx, errorEmbed('This server has no voice channels.'));
      return null;
    }

    const preferredId = this.preferredVoice.get(ctx.serverId);
    const preferred = preferredId ? voiceChannels.find((c) => c.id === preferredId) : undefined;
    const target = preferred ?? this.defaultVoiceChannel(voiceChannels);

    if (!target) {
      await this.reply(
        ctx,
        infoEmbed(
          `I can't tell which voice channel you're in — Echoed's API doesn't expose that.\n` +
          `Run \`${config.prefix}join <channel>\` first, or set \`DEFAULT_VOICE_CHANNEL\`.\n\n` +
          `Voice channels here: ${voiceChannels.map((c) => `\`${c.name}\``).join(', ')}`,
          'Which voice channel?',
        ),
      );
      return null;
    }

    return this.openSession(ctx, target.id);
  }

  private async openSession(ctx: CommandContext, voiceChannelId: string): Promise<Session | null> {
    try {
      const session = await Session.create(
        this.api,
        ctx.serverId,
        voiceChannelId,
        ctx.channelId,
        (serverId) => this.sessions.delete(serverId),
      );
      this.sessions.set(ctx.serverId, session);
      return session;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(`failed to join voice in ${ctx.serverId}:`, detail);

      // A blocked route is not a permission problem, and telling the user to
      // check CONNECT/SPEAK would send them after the wrong thing entirely.
      if (err instanceof VoiceHostUnreachableError) {
        await this.reply(
          ctx,
          errorEmbed(
            `**Echoed's voice server is unreachable from the machine running this bot.**\n` +
            `\`${err.host}:${err.port}\` does not answer — the packets are dropped ` +
            'before they arrive.\n\n' +
            'Nothing is wrong with the bot, its token, or its permissions: the REST ' +
            'API and the gateway both work because they sit behind Cloudflare, while ' +
            'voice runs on a single bare address that this network blocks.\n\n' +
            'Fix it by giving the host a route to that address — a VPN on this ' +
            'machine, or by running the bot on a server outside the blocked network.',
          ),
        );
        return null;
      }

      // A transport problem is not a permission problem, and the CONNECT/SPEAK
      // advice below would send the user after entirely the wrong thing.
      if (err instanceof VoiceTransportError) {
        await this.reply(ctx, errorEmbed(`**Could not join the voice channel.**\n${detail}`));
        return null;
      }

      await this.reply(
        ctx,
        errorEmbed(
          `Could not join the voice channel.\n\`${trim(detail, 300)}\`\n\n` +
          'Make sure the bot has **CONNECT** and **SPEAK** there.',
        ),
      );
      return null;
    }
  }

  /** DEFAULT_VOICE_CHANNEL, else the only voice channel if there is just one. */
  private defaultVoiceChannel(voiceChannels: EchoedChannel[]): EchoedChannel | null {
    if (config.defaultVoiceChannel !== '') {
      const match = findChannel(voiceChannels, config.defaultVoiceChannel);
      if (match) return match;
    }
    return voiceChannels.length === 1 ? (voiceChannels[0] ?? null) : null;
  }

  private async getChannels(serverId: string): Promise<EchoedChannel[]> {
    const cached = this.channelCache.get(serverId);
    if (cached && Date.now() - cached.at < CHANNEL_CACHE_TTL_MS) return cached.channels;

    const channels = await this.api.listChannels(serverId);
    this.channelCache.set(serverId, { at: Date.now(), channels });
    return channels;
  }

  // ── messaging helpers ─────────────────────────────────────────────────────

  private async reply(ctx: CommandContext, embed: EchoedEmbed): Promise<string | null> {
    try {
      const sent = await this.api.sendEmbed(ctx.serverId, ctx.channelId, embed);
      return sent.id;
    } catch (err) {
      log.warn('failed to send reply:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Edits the placeholder in place when possible, else posts a new message. */
  private async replaceOrSend(
    ctx: CommandContext,
    messageId: string | null,
    embed: EchoedEmbed,
  ): Promise<void> {
    if (messageId !== null) {
      try {
        await this.api.editMessage(ctx.serverId, messageId, { embeds: [embed] });
        return;
      } catch (err) {
        log.debug('edit failed, sending new message:', err instanceof Error ? err.message : err);
      }
    }
    await this.reply(ctx, embed);
  }

  private async deleteIfPossible(serverId: string, messageId: string | null): Promise<void> {
    if (messageId === null) return;
    try {
      await this.api.deleteMessage(serverId, messageId);
    } catch {
      // Not fatal — the placeholder just stays visible.
    }
  }
}

/** Accepts "83", "1:23" or "1:02:03". */
function parseTimestamp(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(trimmed)) return null;

  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
