/**
 * Types mirroring the Echoed Bot API payloads used by this bot.
 * Source: https://echoed.gg/developers.php
 */

export interface EchoedEmbedMedia {
  url: string;
  width?: number;
  height?: number;
}

export interface EchoedEmbedAuthor {
  name?: string;
  url?: string;
  icon_url?: string;
}

export interface EchoedEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EchoedEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface EchoedEmbed {
  type: 'rich' | 'image' | 'video' | 'gifv' | 'article' | 'link' | 'audio';
  url?: string;
  title?: string;
  description?: string;
  /** Decimal integer, e.g. 0xFFC928 → 16763688. */
  color?: number;
  /** ISO-8601 UTC. Empty string suppresses. */
  timestamp?: string;
  author?: EchoedEmbedAuthor;
  thumbnail?: EchoedEmbedMedia;
  image?: EchoedEmbedMedia;
  fields?: EchoedEmbedField[];
  footer?: EchoedEmbedFooter;
}

export interface SendMessagePayload {
  channelId: string;
  content: string;
  attachmentIds?: string[];
  mentions?: string[];
  replyToId?: string;
  embeds?: EchoedEmbed[];
}

/**
 * What `POST /{serverId}/messages/send` actually returns — an acknowledgement,
 * not the created message. Verified against a live response:
 *
 *     {"channelId":"…","content":"…","message":"Message sent successfully.",
 *      "messageId":"353137511268093952"}
 *
 * The id comes back as `messageId`, there is no `id`, and none of the other
 * message fields are present. Reading `id` here yields `undefined`, which is
 * silent: every follow-up edit is skipped rather than failing. `id` is kept as
 * an optional fallback in case the shape is ever normalised server-side.
 */
export interface SendMessageAck {
  messageId?: string;
  id?: string;
  channelId?: string;
  content?: string;
  /** Human-readable status text, e.g. "Message sent successfully." */
  message?: string;
}

/** A just-sent message, normalised so callers never see the ack's field names. */
export interface SentMessage {
  /** `null` when the API acknowledged the send without naming the message. */
  id: string | null;
  channelId: string;
}

/** A message as delivered by the gateway, which does use `id`. */
export interface EchoedMessage {
  id: string;
  channelId: string;
  serverId: string;
  senderId: string;
  content: string;
  messageType?: string;
  attachments?: unknown[];
  mentions?: string[];
  replyToId?: string;
  createdAt?: string;
  author?: {
    id: string;
    name: string;
    avatarUrl?: string;
    isBot?: boolean;
  };
}

export interface EchoedChannel {
  id: string;
  name: string;
  /** The docs list text | video | tasks | calendar; `video` is the voice/AV type. */
  type: string;
  description?: string;
  createdAt?: string;
}

/**
 * An entry of `GET /servers`. Field names verified against a live response:
 * the payload uses plain `id`/`name`, not the `serverId`/`serverName` the docs
 * suggest elsewhere.
 */
export interface EchoedServerSummary {
  id: string;
  name: string;
  icon?: string;
  invitedAt?: string;
  settings?: Record<string, unknown>;
}

export interface VoiceJoinResponse {
  success: boolean;
  url: string;
  token: string;
  room: string;
  callId: string;
  identity: string;
  expiresIn: number;
}

/**
 * `GET /profile`. The bot's own settings live under `metadata`, not at the top
 * level; `name` is the display name and `username` the handle.
 */
export interface BotProfile {
  id: string;
  username: string;
  name?: string;
  isBot: boolean;
  avatar?: string;
  official?: boolean;
  verified?: boolean;
  metadata?: {
    botName?: string;
    description?: string;
    categories?: string[];
    /** Bitmask the bot asks servers for; what the invite consent screen offers. */
    requestedPermissions?: number;
    public?: boolean;
    active?: boolean;
    version?: string;
  };
  stats?: {
    createdAt?: string;
    serverCount?: number;
    userCount?: number;
  };
}

export interface ValidateResponse {
  valid: boolean;
  bot_id: string;
  message?: string;
}

export interface PermissionsResponse {
  userId: string;
  serverId: string;
  channelId?: string;
  permissions: string[];
}
