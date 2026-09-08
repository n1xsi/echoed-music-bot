import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type {
  BotProfile,
  EchoedChannel,
  EchoedEmbed,
  EchoedServerSummary,
  PermissionsResponse,
  SendMessageAck,
  SendMessagePayload,
  SentMessage,
  ValidateResponse,
  VoiceJoinResponse,
} from './types.js';

const log = createLogger('api');

export class EchoedApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = 'EchoedApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Retries left for 429 / 5xx. */
  retries?: number;
}

/**
 * Rate-limited REST client for the Echoed Bot API.
 *
 * The API allows 120 requests/minute per bot across all endpoints. Requests are
 * serialised through a queue that paces them to stay under that budget, and 429
 * responses are retried after the server-supplied `retryAfter`.
 */
export class EchoedClient {
  private readonly minIntervalMs = 60_000 / 120; // 500 ms → 120 req/min
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  /** Set when a 429 tells us to back off; all requests wait until then. */
  private backoffUntil = 0;

  constructor(
    private readonly token: string = config.botToken,
    private readonly baseUrl: string = config.apiBase,
  ) { }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async pace(): Promise<void> {
    const now = Date.now();
    const earliest = Math.max(this.lastRequestAt + this.minIntervalMs, this.backoffUntil);
    if (earliest > now) await sleep(earliest - now);
    this.lastRequestAt = Date.now();
  }

  /** Serialises every call so pacing and backoff apply globally. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, retries = 3 } = options;

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    return this.enqueue(async () => {
      let attempt = 0;
      for (; ;) {
        await this.pace();

        const headers: Record<string, string> = { 'X-Bot-Token': this.token };
        let payload: string | undefined;
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(body);
        }

        let response: Response;
        try {
          response = await fetch(url, {
            method,
            headers,
            ...(payload === undefined ? {} : { body: payload }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          if (attempt++ >= retries) throw err;
          const wait = 500 * 2 ** attempt;
          log.warn(`${method} ${path} network error, retry in ${wait}ms:`, describe(err));
          await sleep(wait);
          continue;
        }

        if (response.status === 429) {
          const text = await response.text().catch(() => '');
          const retryAfter = parseRetryAfter(text) ?? 5;
          this.backoffUntil = Date.now() + retryAfter * 1000;
          if (attempt++ >= retries) throw new EchoedApiError(429, text, method, path);
          log.warn(`rate limited on ${method} ${path}; waiting ${retryAfter}s`);
          continue;
        }

        // 503 is documented as transient (database), so it is worth a retry.
        if ((response.status >= 500 || response.status === 408) && attempt++ < retries) {
          const wait = 500 * 2 ** attempt;
          log.warn(`${method} ${path} → ${response.status}, retry in ${wait}ms`);
          await sleep(wait);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new EchoedApiError(response.status, text, method, path);
        }

        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (text === '') return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
    });
  }

  // ── bot profile ───────────────────────────────────────────────────────────

  validate(): Promise<ValidateResponse> {
    return this.request<ValidateResponse>('/validate');
  }

  getProfile(): Promise<BotProfile> {
    return this.request<BotProfile>('/profile');
  }

  // ── servers & channels ────────────────────────────────────────────────────

  async listServers(): Promise<EchoedServerSummary[]> {
    const res = await this.request<{ servers: EchoedServerSummary[]; total: number }>('/servers');
    return res.servers ?? [];
  }

  async listChannels(serverId: string): Promise<EchoedChannel[]> {
    const res = await this.request<{ channels: EchoedChannel[]; total: number }>(
      `/${serverId}/channels`,
    );
    return res.channels ?? [];
  }

  // ── messages ──────────────────────────────────────────────────────────────

  /**
   * Returns the id normalised out of the send acknowledgement, which names it
   * `messageId`. Anything that later edits or deletes the message must go
   * through this rather than reading the raw response.
   */
  async sendMessage(serverId: string, payload: SendMessagePayload): Promise<SentMessage> {
    const ack = await this.request<SendMessageAck>(`/${serverId}/messages/send`, {
      method: 'POST',
      body: {
        attachmentIds: [],
        mentions: [],
        replyToId: '',
        ...payload,
      },
    });

    const id = ack?.messageId ?? ack?.id ?? null;
    if (id === null) {
      log.warn('message sent but the response carried no id; it cannot be edited later');
    }
    return { id, channelId: ack?.channelId ?? payload.channelId };
  }

  sendText(serverId: string, channelId: string, content: string): Promise<SentMessage> {
    return this.sendMessage(serverId, { channelId, content });
  }

  sendEmbed(
    serverId: string,
    channelId: string,
    embed: EchoedEmbed,
    content = '',
  ): Promise<SentMessage> {
    return this.sendMessage(serverId, { channelId, content, embeds: [embed] });
  }

  editMessage(
    serverId: string,
    messageId: string,
    body: { content?: string; embeds?: EchoedEmbed[] },
  ): Promise<unknown> {
    return this.request(`/${serverId}/messages/${messageId}`, { method: 'PUT', body });
  }

  deleteMessage(serverId: string, messageId: string): Promise<unknown> {
    return this.request(`/${serverId}/messages/${messageId}`, { method: 'DELETE' });
  }

  addReaction(serverId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.request(
      `/${serverId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
    );
  }

  // ── permissions ───────────────────────────────────────────────────────────

  getMemberPermissions(
    serverId: string,
    userId: string,
    channelId?: string,
  ): Promise<PermissionsResponse> {
    return this.request<PermissionsResponse>(`/${serverId}/members/${userId}/permissions`, {
      query: channelId ? { channel_id: channelId } : {},
    });
  }

  // ── voice ─────────────────────────────────────────────────────────────────

  joinVoice(serverId: string, channelId: string): Promise<VoiceJoinResponse> {
    return this.request<VoiceJoinResponse>(`/${serverId}/voice/${channelId}/join`, {
      method: 'POST',
    });
  }

  /** Bookkeeping only — the real disconnect is `Room.disconnect()` client-side. */
  leaveVoice(serverId: string, channelId: string): Promise<unknown> {
    return this.request(`/${serverId}/voice/${channelId}/leave`, { method: 'POST' });
  }
}

function parseRetryAfter(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { retryAfter?: number };
    return typeof parsed.retryAfter === 'number' ? parsed.retryAfter : null;
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
