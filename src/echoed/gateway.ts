import { EventEmitter } from 'node:events';

import { io, type Socket } from 'socket.io-client';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type { EchoedMessage } from './types.js';

const log = createLogger('gateway');

/** Docs: "Send a heartbeat every 30 seconds to keep the connection alive." */
const HEARTBEAT_MS = 30_000;

/**
 * The gateway answers a heartbeat with `heartbeatAck` in about 170 ms. Treating
 * a much longer silence as a dead connection is safe, and it is the earliest
 * signal available that the socket has stopped working.
 */
const ACK_DEADLINE_MS = 10_000;

/**
 * Engine-level pings arrive every ~25.2 s. Socket.IO itself only gives up after
 * `pingInterval + pingTimeout` = 45 s, during which the bot looks connected and
 * silently misses every command. Measured against the live gateway, connections
 * die at unpredictable times (~50 s to ~170 s), so shortening the detection
 * window matters more than preventing the drop, which is not ours to prevent.
 */
const SILENCE_LIMIT_MS = 32_000;

/** How often the watchdog re-checks the two deadlines above. */
const WATCHDOG_TICK_MS = 4_000;

export interface GatewayEvents {
  ready: [sessionId: string];
  messageCreate: [message: EchoedMessage];
  disconnect: [reason: string];
}

/**
 * Socket.IO connection to Echoed. On `authenticate` the bot is auto-subscribed
 * to every server it has been invited to — there is no separate subscribe step.
 */
export class EchoedGateway extends EventEmitter<GatewayEvents> {
  private socket: Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;
  /** Last time anything at all arrived from the server, engine pings included. */
  private lastInboundAt = 0;
  /** When the outstanding heartbeat was sent, or 0 when none is in flight. */
  private heartbeatSentAt = 0;

  constructor(
    private readonly token: string = config.botToken,
    private readonly url: string = config.socketUrl,
  ) {
    super();
  }

  connect(): void {
    if (this.socket) return;

    log.info(`connecting to ${this.url}`);
    const socket = io(this.url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 20_000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      log.debug('socket connected, authenticating');
      this.markInbound();
      socket.emit('authenticate', { botToken: this.token });
    });

    // Engine packets are the only traffic that keeps flowing when the bot is
    // idle, so liveness is judged on them rather than on application events.
    // The engine is replaced on every reconnect, hence re-subscribing on `open`.
    socket.io.on('open', () => {
      this.markInbound();
      socket.io.engine?.on('packet', () => this.markInbound());
    });
    socket.onAny(() => this.markInbound());

    socket.on('heartbeatAck', () => {
      this.heartbeatSentAt = 0;
      this.markInbound();
    });

    socket.on('authenticated', (payload: { sessionId?: string } = {}) => {
      log.info(`authenticated (session ${payload.sessionId ?? 'unknown'})`);
      this.markInbound();
      this.startHeartbeat();
      this.startWatchdog();
      this.emit('ready', payload.sessionId ?? '');
    });

    socket.on('unauthorized', (payload: unknown) => {
      log.error('authentication rejected — check ECHOED_BOT_TOKEN:', payload);
    });

    socket.on('MESSAGE_CREATE', (data: EchoedMessage) => {
      this.emit('messageCreate', data);
    });

    socket.on('disconnect', (reason: string) => {
      this.stopHeartbeat();
      this.stopWatchdog();
      log.warn(`socket disconnected: ${reason}`);
      this.emit('disconnect', reason);
    });

    socket.on('connect_error', (err: Error) => {
      log.warn('connect error:', err.message);
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatSentAt = 0;
    // The token must be included on every heartbeat, per the docs.
    this.heartbeat = setInterval(() => {
      // Keep the oldest unanswered timestamp: it is what the watchdog measures.
      if (this.heartbeatSentAt === 0) this.heartbeatSentAt = Date.now();
      this.socket?.emit('heartbeat', { botToken: this.token });
    }, HEARTBEAT_MS);
    // Don't hold the event loop open on shutdown.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.heartbeatSentAt = 0;
  }

  private markInbound(): void {
    this.lastInboundAt = Date.now();
  }

  /**
   * Forces a reconnect as soon as the connection looks dead, rather than waiting
   * out Socket.IO's 45 s ping timeout with the bot ignoring every command.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.closed || !this.socket?.connected) return;

      const now = Date.now();
      const silentFor = now - this.lastInboundAt;
      const ackOverdue = this.heartbeatSentAt !== 0 && now - this.heartbeatSentAt > ACK_DEADLINE_MS;

      if (!ackOverdue && silentFor <= SILENCE_LIMIT_MS) return;

      const why = ackOverdue
        ? `heartbeat unanswered for ${Math.round((now - this.heartbeatSentAt) / 1000)}s`
        : `nothing received for ${Math.round(silentFor / 1000)}s`;
      log.warn(`connection looks dead (${why}); reconnecting early`);

      // Closing the engine rather than the socket keeps Socket.IO's own
      // reconnection logic in charge, so backoff and re-auth still apply.
      this.stopHeartbeat();
      this.socket.io.engine?.close();
    }, WATCHDOG_TICK_MS);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.stopWatchdog();
    this.socket?.disconnect();
    this.socket = null;
  }
}
