import Redis from "ioredis";

export const SUPPORTED_SPORT_KEYS = [
  "americanfootball_nfl",
  "basketball_nba",
] as const;

export type SupportedSportKey = (typeof SUPPORTED_SPORT_KEYS)[number];

export const HOT_CACHE_TTL_SECONDS = 45;

export function isSupportedSportKey(
  value: string | null | undefined,
): value is SupportedSportKey {
  if (!value) {
    return false;
  }
  return (SUPPORTED_SPORT_KEYS as readonly string[]).includes(value);
}

export function oddsLatestKey(sportKey: string, eventId: string): string {
  return `odds:latest:${sportKey}:${eventId}`;
}

export function evFeedKey(sportKey: string): string {
  return `ev:feed:${sportKey}`;
}

export function sgpAuditKey(eventId: string): string {
  return `sgp:audit:${eventId}`;
}

export function oddsFeedChannel(sportKey: string): string {
  return `odds:feed:${sportKey}`;
}

export function presetsFeedKey(sportKey?: string): string {
  if (sportKey && sportKey.toLowerCase().includes("nfl")) {
    return "presets:feed:nfl";
  }
  if (sportKey && sportKey.toLowerCase().includes("nba")) {
    return "presets:feed:nba";
  }
  return "presets:feed:all";
}

export function formatIso8601Utc(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface RedisSubscriber {
  connect?(): Promise<unknown>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(
    event: "message",
    listener: (channel: string, message: string) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  removeAllListeners(event?: string): this;
}

export type RedisSubscriberFactory = () => RedisSubscriber;

function defaultSubscriberFactory(): RedisSubscriber {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

let activeSubscriberFactory: RedisSubscriberFactory = defaultSubscriberFactory;

export function createRedisSubscriber(): RedisSubscriber {
  return activeSubscriberFactory();
}

export function setRedisSubscriberFactory(
  factory: RedisSubscriberFactory | null,
): void {
  activeSubscriberFactory = factory ?? defaultSubscriberFactory;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export type RedisClientFactory = () => RedisClient;

function defaultClientFactory(): RedisClient {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379/0";
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

let activeClientFactory: RedisClientFactory = defaultClientFactory;

export function createRedisClient(): RedisClient {
  return activeClientFactory();
}

export function setRedisClientFactory(factory: RedisClientFactory | null): void {
  activeClientFactory = factory ?? defaultClientFactory;
}
