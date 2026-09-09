import type { Track } from '../audio/resolver.js';
import type { EchoedEmbed } from '../echoed/types.js';
import type { LoopMode } from '../player/queue.js';

/** Accent colours as decimal ints, per the embed spec. */
export const COLORS = {
  playing: 0x1db954, // green
  queued: 0x5865f2, // indigo
  info: 0xffc928, // amber
  error: 0xed4245, // red
} as const;

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'LIVE';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const BAR_WIDTH = 20;

export function progressBar(position: number, duration: number): string {
  if (duration <= 0) return '▰'.repeat(2) + '▱'.repeat(BAR_WIDTH - 2);
  const ratio = Math.min(1, Math.max(0, position / duration));
  const filled = Math.round(ratio * BAR_WIDTH);
  return '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled);
}

function trackLink(track: Track): string {
  // Deferred Spotify entries have no real URL yet.
  return track.url.startsWith('search:') ? track.title : `[${track.title}](${track.url})`;
}

export function nowPlayingEmbed(
  track: Track,
  position: number,
  opts: { paused: boolean; loop: LoopMode; volume: number; queueLength: number },
): EchoedEmbed {
  const lines: string[] = [`**${trackLink(track)}**`, track.author];

  if (track.isLive) {
    lines.push('', '🔴 Live stream');
  } else {
    lines.push(
      '',
      `${progressBar(position, track.duration)}`,
      `\`${formatDuration(position)} / ${formatDuration(track.duration)}\``,
    );
  }

  const flags: string[] = [];
  if (opts.paused) flags.push('⏸ Paused');
  if (opts.loop === 'track') flags.push('🔂 Looping track');
  if (opts.loop === 'queue') flags.push('🔁 Looping queue');
  if (opts.volume !== 100) flags.push(`🔊 ${opts.volume}%`);
  if (flags.length > 0) lines.push('', flags.join(' · '));

  const footerParts = [track.source, `requested by ${track.requestedBy}`];
  if (opts.queueLength > 0) footerParts.push(`${opts.queueLength} in queue`);

  return {
    type: 'rich',
    title: opts.paused ? 'Paused' : 'Now playing',
    description: lines.join('\n'),
    color: opts.paused ? COLORS.info : COLORS.playing,
    footer: { text: footerParts.join(' · ') },
    ...(track.thumbnail ? { thumbnail: { url: track.thumbnail } } : {}),
  };
}

export function queuedEmbed(track: Track, position: number): EchoedEmbed {
  return {
    type: 'rich',
    title: 'Added to queue',
    description: `**${trackLink(track)}**\n${track.author}`,
    color: COLORS.queued,
    fields: [
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Position', value: `#${position}`, inline: true },
      { name: 'Source', value: track.source, inline: true },
    ],
    footer: { text: `requested by ${track.requestedBy}` },
    ...(track.thumbnail ? { thumbnail: { url: track.thumbnail } } : {}),
  };
}

export function playlistEmbed(
  title: string,
  tracks: Track[],
  truncated: number,
  startPosition: number,
): EchoedEmbed {
  const preview = tracks
    .slice(0, 5)
    .map((t, i) => `**${startPosition + i}.** ${t.title} \`${formatDuration(t.duration)}\``)
    .join('\n');
  const rest = tracks.length > 5 ? `\n…and ${tracks.length - 5} more` : '';
  const dropped = truncated > 0 ? `\n\n⚠️ ${truncated} track(s) beyond the limit were skipped.` : '';

  return {
    type: 'rich',
    title: 'Playlist added',
    description: `**${title}**\n\n${preview}${rest}${dropped}`,
    color: COLORS.queued,
    footer: {
      text: `${tracks.length} track(s) · requested by ${tracks[0]?.requestedBy ?? 'unknown'}`,
    },
    ...(tracks[0]?.thumbnail ? { thumbnail: { url: tracks[0].thumbnail } } : {}),
  };
}

export function queueEmbed(
  current: Track | null,
  position: number,
  upcoming: readonly Track[],
  opts: { loop: LoopMode; page: number; pageSize: number; totalDuration: number },
): EchoedEmbed {
  const sections: string[] = [];

  if (current) {
    const suffix = current.isLive
      ? '`LIVE`'
      : `\`${formatDuration(position)} / ${formatDuration(current.duration)}\``;
    sections.push(`**Now playing**\n${trackLink(current)} ${suffix}`);
  }

  const pages = Math.max(1, Math.ceil(upcoming.length / opts.pageSize));
  const page = Math.min(Math.max(1, opts.page), pages);
  const start = (page - 1) * opts.pageSize;
  const slice = upcoming.slice(start, start + opts.pageSize);

  if (slice.length > 0) {
    const list = slice
      .map(
        (t, i) =>
          `**${start + i + 1}.** ${trackLink(t)} \`${formatDuration(t.duration)}\` · ${t.requestedBy}`,
      )
      .join('\n');
    sections.push(`**Up next**\n${list}`);
  } else if (!current) {
    sections.push('The queue is empty. Add something with `/play`.');
  } else {
    sections.push('Nothing queued after this.');
  }

  const footer: string[] = [];
  if (upcoming.length > 0) {
    footer.push(`${upcoming.length} track(s)`);
    if (opts.totalDuration > 0) footer.push(formatDuration(opts.totalDuration));
  }
  if (pages > 1) footer.push(`page ${page}/${pages}`);
  if (opts.loop !== 'off') footer.push(opts.loop === 'track' ? 'looping track' : 'looping queue');

  return {
    type: 'rich',
    title: 'Queue',
    description: sections.join('\n\n'),
    color: COLORS.info,
    ...(footer.length > 0 ? { footer: { text: footer.join(' · ') } } : {}),
  };
}

export function errorEmbed(message: string): EchoedEmbed {
  return { type: 'rich', title: 'Error', description: message, color: COLORS.error };
}

export function infoEmbed(message: string, title?: string): EchoedEmbed {
  return {
    type: 'rich',
    description: message,
    color: COLORS.info,
    ...(title === undefined ? {} : { title }),
  };
}
