import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { parseJsonLines, runYtDlp, type YtDlpEntry } from './ytdlp.js';

const log = createLogger('resolver');

export interface Track {
  /** Page URL passed back to yt-dlp at playback time. */
  url: string;
  title: string;
  author: string;
  /** Seconds; 0 when unknown (e.g. live streams). */
  duration: number;
  thumbnail?: string;
  /** Human-readable source, e.g. "YouTube", "SoundCloud". */
  source: string;
  isLive: boolean;
  requestedBy: string;
  requestedById: string;
}

export interface ResolveResult {
  tracks: Track[];
  /** Set when the input was a playlist/album. */
  playlistTitle?: string;
  /** How many tracks were dropped by MAX_PLAYLIST_TRACKS. */
  truncated: number;
}

interface Requester {
  name: string;
  id: string;
}

const URL_RE = /^https?:\/\//i;

/** Spotify has no playable audio for bots, so tracks are matched on YouTube. */
const SPOTIFY_RE = /^https?:\/\/(open|play)\.spotify\.com\//i;

export async function resolveQuery(query: string, requester: Requester): Promise<ResolveResult> {
  const input = query.trim();
  if (input === '') return { tracks: [], truncated: 0 };

  if (SPOTIFY_RE.test(input)) return resolveSpotify(input, requester);
  if (URL_RE.test(input)) return resolveUrl(input, requester);
  return resolveSearch(input, requester);
}

/**
 * Any of yt-dlp's 900+ supported sites. `--flat-playlist` keeps playlist
 * resolution to a single request; the real stream URL is fetched at play time.
 */
async function resolveUrl(url: string, requester: Requester): Promise<ResolveResult> {
  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-end', String(config.maxPlaylistTracks), url],
    90_000,
  );
  const parsed = parseJsonLines(stdout);
  const root = parsed[0];
  if (!root) return { tracks: [], truncated: 0 };

  if (root._type === 'playlist' && Array.isArray(root.entries)) {
    const entries = root.entries.filter((e) => e && (e.url ?? e.webpage_url ?? e.id));
    const capped = entries.slice(0, config.maxPlaylistTracks);
    const tracks = capped
      .map((entry) => toTrack(entry, requester, url))
      .filter((t): t is Track => t !== null);
    const total = root.playlist_count ?? entries.length;
    return {
      tracks,
      playlistTitle: root.title ?? 'Playlist',
      truncated: Math.max(0, total - capped.length),
    };
  }

  const track = toTrack(root, requester, url);
  return { tracks: track ? [track] : [], truncated: 0 };
}

/** Free-text search — first YouTube hit, matching what users expect from /play. */
async function resolveSearch(query: string, requester: Requester): Promise<ResolveResult> {
  const stdout = await runYtDlp(
    ['--dump-single-json', '--no-playlist', '--default-search', 'ytsearch', `ytsearch1:${query}`],
    60_000,
  );
  const parsed = parseJsonLines(stdout);
  const root = parsed[0];
  if (!root) return { tracks: [], truncated: 0 };

  // ytsearch returns a playlist wrapper even for a single result.
  const entry = root._type === 'playlist' ? root.entries?.[0] : root;
  if (!entry) return { tracks: [], truncated: 0 };

  const track = toTrack(entry, requester);
  return { tracks: track ? [track] : [], truncated: 0 };
}

/**
 * Spotify streams are DRM-protected, so we read the metadata and then search
 * YouTube for each title — the standard approach for music bots.
 */
async function resolveSpotify(url: string, requester: Requester): Promise<ResolveResult> {
  const { getDetails } = await loadSpotify();

  let details: SpotifyDetails;
  try {
    details = (await getDetails(url)) as SpotifyDetails;
  } catch (err) {
    log.warn('spotify metadata lookup failed:', err instanceof Error ? err.message : err);
    throw new Error('Could not read that Spotify link.');
  }

  const preview = details.preview ?? {};
  const rawTracks = Array.isArray(details.tracks) ? details.tracks : [];

  // A single track link yields no `tracks` array, only a preview.
  const wanted: { title: string; artist: string }[] =
    rawTracks.length > 0
      ? rawTracks.map((t) => ({
        title: t.name ?? t.title ?? '',
        artist: firstArtist(t) ?? preview.artist ?? '',
      }))
      : [{ title: preview.track ?? preview.title ?? '', artist: preview.artist ?? '' }];

  const usable = wanted.filter((t) => t.title !== '');
  if (usable.length === 0) throw new Error('That Spotify link has no playable tracks.');

  const capped = usable.slice(0, config.maxPlaylistTracks);
  const isCollection = rawTracks.length > 1;

  // Resolving every track up front would be slow for a 100-song playlist, so
  // only the first is matched now; the rest resolve lazily on playback.
  const first = capped[0];
  const tracks: Track[] = [];
  if (first) {
    const found = await resolveSearch(searchTerm(first), requester);
    const hit = found.tracks[0];
    if (hit) tracks.push({ ...hit, title: first.title, author: first.artist || hit.author });
  }

  for (const item of capped.slice(1)) {
    tracks.push({
      // Deferred: `search:` is expanded by the player when the track comes up.
      url: `search:${searchTerm(item)}`,
      title: item.title,
      author: item.artist,
      duration: 0,
      source: 'Spotify',
      isLive: false,
      requestedBy: requester.name,
      requestedById: requester.id,
      ...(preview.image ? { thumbnail: preview.image } : {}),
    });
  }

  if (tracks.length === 0) throw new Error('Could not find those Spotify tracks anywhere.');

  return {
    tracks,
    ...(isCollection ? { playlistTitle: preview.title ?? 'Spotify playlist' } : {}),
    truncated: Math.max(0, usable.length - capped.length),
  };
}

/** Resolves a deferred `search:<terms>` placeholder into a real track. */
export async function resolveDeferred(track: Track): Promise<Track | null> {
  if (!track.url.startsWith('search:')) return track;
  const terms = track.url.slice('search:'.length);
  const result = await resolveSearch(terms, {
    name: track.requestedBy,
    id: track.requestedById,
  });
  const hit = result.tracks[0];
  if (!hit) return null;
  // Keep the Spotify-supplied title/artist; they read better than the video title.
  return {
    ...hit,
    title: track.title || hit.title,
    author: track.author || hit.author,
    ...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
  };
}

function toTrack(entry: YtDlpEntry, requester: Requester, fallbackUrl?: string): Track | null {
  const url = entry.webpage_url ?? entry.original_url ?? entry.url ?? fallbackUrl;
  if (url === undefined || url === '') return null;

  const live = entry.is_live === true || entry.live_status === 'is_live';
  const thumbnail = entry.thumbnail;

  return {
    url,
    title: entry.track ?? entry.title ?? 'Unknown title',
    author: entry.artist ?? entry.uploader ?? entry.channel ?? entry.creator ?? 'Unknown artist',
    duration: live ? 0 : Math.max(0, Math.round(entry.duration ?? 0)),
    source: prettySource(entry),
    isLive: live,
    requestedBy: requester.name,
    requestedById: requester.id,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function prettySource(entry: YtDlpEntry): string {
  const key = entry.extractor_key ?? entry.extractor ?? 'Unknown';
  // Extractor keys look like "Youtube", "SoundcloudSet", "BandcampAlbum".
  const map: Record<string, string> = {
    Youtube: 'YouTube',
    YoutubeMusic: 'YouTube Music',
    Soundcloud: 'SoundCloud',
    Bandcamp: 'Bandcamp',
    Vimeo: 'Vimeo',
    Twitch: 'Twitch',
    Bilibili: 'Bilibili',
    NicoNico: 'Niconico',
    Mixcloud: 'Mixcloud',
    Deezer: 'Deezer',
    YandexMusic: 'Yandex Music',
    VKMusic: 'VK Music',
    Odnoklassniki: 'OK',
    Tidal: 'Tidal',
    AppleMusic: 'Apple Music',
  };
  const base = key.replace(/(Set|Album|Playlist|Track|User|Channel|Tab|IE)$/i, '') || key;
  return map[base] ?? base;
}

function searchTerm(item: { title: string; artist: string }): string {
  return item.artist === '' ? item.title : `${item.artist} - ${item.title}`;
}

interface SpotifyTrack {
  name?: string;
  title?: string;
  artist?: string;
  artists?: { name?: string }[];
}

interface SpotifyDetails {
  preview?: {
    title?: string;
    track?: string;
    artist?: string;
    image?: string;
  };
  tracks?: SpotifyTrack[];
}

function firstArtist(track: SpotifyTrack): string | undefined {
  if (typeof track.artist === 'string' && track.artist !== '') return track.artist;
  const named = track.artists?.map((a) => a.name).filter((n): n is string => !!n);
  return named && named.length > 0 ? named.join(', ') : undefined;
}

type SpotifyApi = { getDetails(url: string): Promise<unknown> };
let spotifyApi: SpotifyApi | null = null;

/** spotify-url-info is a factory taking a fetch implementation. */
async function loadSpotify(): Promise<SpotifyApi> {
  if (spotifyApi) return spotifyApi;
  const mod = (await import('spotify-url-info')) as unknown as {
    default: (fetchImpl: typeof fetch) => SpotifyApi;
  };
  const factory = mod.default;
  spotifyApi = factory(fetch);
  return spotifyApi;
}
