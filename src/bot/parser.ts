import type { EchoedChannel } from '../echoed/types.js';

export interface ParsedCommand {
  name: string;
  args: string;
  argv: string[];
}

/** Parses "/play some song" into { name: 'play', args: 'some song' }. */
export function parseCommand(content: string, prefix: string): ParsedCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const body = trimmed.slice(prefix.length).trim();
  if (body === '') return null;

  const firstSpace = body.search(/\s/);
  const name = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? '' : body.slice(firstSpace + 1).trim();

  return { name, args, argv: args === '' ? [] : args.split(/\s+/) };
}

/**
 * Echoed's channel list marks voice/AV channels as type `video`; the docs list
 * text | video | tasks | calendar. Tolerate a few likely aliases.
 */
const VOICE_TYPES = new Set(['video', 'voice', 'audio']);

export function isVoiceChannel(channel: EchoedChannel): boolean {
  return VOICE_TYPES.has(channel.type.toLowerCase());
}

/** Matches a channel by exact id, then by case-insensitive name. */
export function findChannel(
  channels: readonly EchoedChannel[],
  needle: string,
): EchoedChannel | null {
  const query = needle.trim().replace(/^#/, '');
  if (query === '') return null;

  const byId = channels.find((c) => c.id === query);
  if (byId) return byId;

  const lower = query.toLowerCase();
  const exact = channels.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact;

  const partial = channels.filter((c) => c.name.toLowerCase().includes(lower));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}
