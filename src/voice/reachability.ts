import net from 'node:net';

import { createLogger } from '../logger.js';

const log = createLogger('voice');

/**
 * How long to wait for a TCP handshake. Echoed's voice server answers in
 * 150-300 ms from anywhere on the public internet, so anything past a couple of
 * seconds means the packets are going nowhere rather than arriving slowly.
 */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * A reachable host is cached for a while — joining voice repeatedly should not
 * re-probe. A blocked one is re-checked much sooner, so that switching on a VPN
 * takes effect on the next `/play` instead of after a restart.
 */
const CACHE_OK_MS = 300_000;
const CACHE_FAIL_MS = 20_000;

const cache = new Map<string, { at: number; ok: boolean }>();

/**
 * Thrown instead of letting LiveKit time out on its own. The SDK reports an
 * unreachable server as `engine: signal failure: transport timed out` after
 * ~15 s, which reads like a bug in the bot rather than a blocked route.
 */
export class VoiceHostUnreachableError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly detail: string,
  ) {
    super(`Echoed's voice server ${host}:${port} is unreachable from this machine (${detail}).`);
    this.name = 'VoiceHostUnreachableError';
  }
}

/** `wss://host[:port]/path` → the TCP endpoint the LiveKit signal socket needs. */
export function parseWsEndpoint(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
  };
}

/**
 * Opens and immediately drops a TCP connection. Distinguishes the three cases
 * that matter: an answer, an active refusal, and silence.
 */
export async function probeTcp(
  host: string,
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean, detail: string): void => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt, detail });
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'no response to the TCP handshake'));
    socket.once('connect', () => finish(true, 'connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code ?? err.message));
  });
}

/**
 * Verifies the voice server can be reached before handing the URL to LiveKit.
 *
 * This exists because the failure is routinely *not* the bot's fault: Echoed
 * runs its LiveKit/TURN servers on one bare IP that is not behind Cloudflare,
 * while the REST API and the gateway are. Some networks — Russian ISPs in
 * particular — drop traffic to that address while everything else about Echoed
 * keeps working, which produces a bot that talks, sees channels, and appears in
 * the member list but never carries audio.
 */
export async function assertVoiceHostReachable(url: string): Promise<void> {
  const { host, port } = parseWsEndpoint(url);
  const key = `${host}:${port}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (cached.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) {
    if (cached.ok) return;
    throw new VoiceHostUnreachableError(host, port, 'no response to the TCP handshake');
  }

  const result = await probeTcp(host, port);
  cache.set(key, { at: Date.now(), ok: result.ok });

  if (result.ok) {
    log.debug(`voice host ${key} reachable in ${result.ms}ms`);
    return;
  }

  log.warn(`voice host ${key} unreachable after ${result.ms}ms: ${result.detail}`);
  throw new VoiceHostUnreachableError(host, port, result.detail);
}

/** Forgets cached verdicts — used by the startup check so it always measures. */
export function clearReachabilityCache(): void {
  cache.clear();
}

/**
 * A LiveKit connection that failed after the address proved routable. Separate
 * from `VoiceHostUnreachableError` so the reply can explain the transport rather
 * than blame permissions, and separate from a generic error so it never picks up
 * the "check CONNECT and SPEAK" advice, which is wrong for every case of it.
 */
export class VoiceTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceTransportError';
  }
}

/**
 * Turns a LiveKit connect failure into the cause it actually implies.
 *
 * The two timeouts mean very different things and the SDK's wording does not say
 * so: `signal failure` is the WebSocket to the server, while
 * `wait_pc_connection` means signalling succeeded and the media PeerConnection
 * never came up — a UDP problem, or two clients claiming one identity.
 */
export function explainLiveKitFailure(err: unknown, host: string, port: number): Error {
  const message = err instanceof Error ? err.message : String(err);

  if (/wait_pc_connection/i.test(message)) {
    return new VoiceTransportError(
      `Reached ${host}:${port} and completed signalling, but the media connection ` +
      `never established (${message}).\n\n` +
      'Two causes produce this. Most often another copy of the bot is running: ' +
      'both join under the same identity, and LiveKit evicts whichever was there ' +
      'first, so the copies kick each other out. Otherwise the path is not ' +
      'carrying WebRTC media, which is UDP — a proxy-mode VPN cannot carry it at ' +
      'all, and some tunnels need UDP relay enabled.',
    );
  }

  if (/timed out|timeout/i.test(message)) {
    return new VoiceTransportError(
      `Reached ${host}:${port} over TCP, but the signal WebSocket never completed ` +
      `(${message}). The address answers, so this points at the WebSocket or TLS ` +
      'handshake being interfered with rather than at the bot, the token, or its ' +
      'permissions.',
    );
  }

  return err instanceof Error ? err : new Error(message);
}
