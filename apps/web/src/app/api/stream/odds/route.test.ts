import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import {
  evFeedKey,
  oddsFeedChannel,
  oddsLatestKey,
  type RedisSubscriber,
  setRedisSubscriberFactory,
  sgpAuditKey,
} from "@/lib/redis";

class FakeRedisSubscriber extends EventEmitter implements RedisSubscriber {
  public connected = false;
  public subscribedChannels: string[] = [];
  public unsubscribedChannels: string[] = [];
  public quitCalled = false;
  public disconnectCalled = false;
  public shouldFailConnect = false;

  async connect(): Promise<void> {
    if (this.shouldFailConnect) {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    }
    this.connected = true;
  }

  async subscribe(...channels: string[]): Promise<number> {
    if (this.shouldFailConnect) {
      throw new Error("Redis connection closed");
    }
    this.subscribedChannels.push(...channels);
    return this.subscribedChannels.length;
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    this.unsubscribedChannels.push(...channels);
  }

  async quit(): Promise<string> {
    this.quitCalled = true;
    return "OK";
  }

  disconnect(): void {
    this.disconnectCalled = true;
  }
}

afterEach(() => {
  setRedisSubscriberFactory(null);
});

describe("GET /api/stream/odds", () => {
  it("streams initial connection frame, forwards Redis Pub/Sub messages, and cleans up on AbortSignal", async () => {
    const fakeSubscriber = new FakeRedisSubscriber();
    setRedisSubscriberFactory(() => fakeSubscriber);

    const abortController = new AbortController();
    const request = new Request(
      "http://localhost:3000/api/stream/odds?sport_key=americanfootball_nfl",
      { signal: abortController.signal },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(fakeSubscriber.subscribedChannels).toEqual([
      "odds:feed:americanfootball_nfl",
    ]);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    // 1. Read initial connection frame
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    const firstText = decoder.decode(firstChunk.value);
    expect(firstText).toContain("event: connected\n");
    expect(firstText).toContain('"channel":"odds:feed:americanfootball_nfl"');
    expect(firstText).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    // 2. Emit delta from Redis channel and read SSE frame
    const deltaPayload = JSON.stringify({
      event_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      external_provider_id: "papi_nfl_12345",
      sport_key: "americanfootball_nfl",
      decimal_odds: "1.9091",
      updated_at: "2026-11-09T04:30:00Z",
    });
    fakeSubscriber.emit(
      "message",
      "odds:feed:americanfootball_nfl",
      deltaPayload,
    );

    const secondChunk = await reader!.read();
    expect(secondChunk.done).toBe(false);
    const secondText = decoder.decode(secondChunk.value);
    expect(secondText).toBe(`data: ${deltaPayload}\n\n`);

    // 3. Abort client connection and verify Redis subscriber cleanup
    abortController.abort();
    const finalChunk = await reader!.read();
    expect(finalChunk.done).toBe(true);
    expect(fakeSubscriber.unsubscribedChannels).toContain(
      "odds:feed:americanfootball_nfl",
    );
    expect(fakeSubscriber.quitCalled).toBe(true);
  });

  it("sanitizes multi-line Redis messages and cleans up when Redis emits end/close mid-stream", async () => {
    const fakeSubscriber = new FakeRedisSubscriber();
    setRedisSubscriberFactory(() => fakeSubscriber);

    const request = new Request(
      "http://localhost:3000/api/stream/odds?sport_key=basketball_nba",
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    // Consume initial frame
    await reader!.read();

    // Emit message containing embedded newlines
    fakeSubscriber.emit(
      "message",
      "odds:feed:basketball_nba",
      '{\n  "event_id": "1",\r\n  "decimal_odds": "1.95"\n}',
    );

    const deltaChunk = await reader!.read();
    expect(deltaChunk.done).toBe(false);
    expect(decoder.decode(deltaChunk.value)).toBe(
      'data: {   "event_id": "1",   "decimal_odds": "1.95" }\n\n',
    );

    // Emit Redis connection close mid-stream and verify stream closes and subscriber cleans up
    fakeSubscriber.emit("close");
    const closedChunk = await reader!.read();
    expect(closedChunk.done).toBe(true);
    expect(fakeSubscriber.unsubscribedChannels).toContain(
      "odds:feed:basketball_nba",
    );
    expect(fakeSubscriber.quitCalled).toBe(true);
  });

  it("supports ?sport=all by subscribing to all supported sport channels", async () => {
    const fakeSubscriber = new FakeRedisSubscriber();
    setRedisSubscriberFactory(() => fakeSubscriber);

    const request = new Request("http://localhost:3000/api/stream/odds?sport=all");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(fakeSubscriber.subscribedChannels).toEqual([
      "odds:feed:americanfootball_nfl",
      "odds:feed:basketball_nba",
    ]);

    const reader = response.body?.getReader();
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    const decoder = new TextDecoder();
    const firstText = decoder.decode(firstChunk.value);
    expect(firstText).toContain('"sport_key":"all"');
  });

  it("supports ?sport=nfl and ?sport=nba query aliases", async () => {
    const fakeSubscriber = new FakeRedisSubscriber();
    setRedisSubscriberFactory(() => fakeSubscriber);

    const requestNfl = new Request("http://localhost:3000/api/stream/odds?sport=nfl");
    const responseNfl = await GET(requestNfl);
    expect(responseNfl.status).toBe(200);
    expect(fakeSubscriber.subscribedChannels).toContain("odds:feed:americanfootball_nfl");

    const fakeSubscriberNba = new FakeRedisSubscriber();
    setRedisSubscriberFactory(() => fakeSubscriberNba);

    const requestNba = new Request("http://localhost:3000/api/stream/odds?sport=nba");
    const responseNba = await GET(requestNba);
    expect(responseNba.status).toBe(200);
    expect(fakeSubscriberNba.subscribedChannels).toContain("odds:feed:basketball_nba");
  });

    it("returns 400 Problem Details when sport_key is missing or unsupported", async () => {
    const request = new Request(
      "http://localhost:3000/api/stream/odds?sport_key=baseball_mlb",
    );

    const response = await GET(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "INVALID_SPORT_KEY",
        message: expect.stringContaining("sport_key"),
        retry_after: 60,
      },
    });
  });

  it("returns 503 Problem Details when Redis is unreachable", async () => {
    const failingSubscriber = new FakeRedisSubscriber();
    failingSubscriber.shouldFailConnect = true;
    setRedisSubscriberFactory(() => failingSubscriber);

    const request = new Request(
      "http://localhost:3000/api/stream/odds?sport_key=basketball_nba",
    );

    const response = await GET(request);
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "STREAM_UNAVAILABLE",
        message: "Real-time odds stream is currently unavailable.",
        retry_after: 60,
      },
    });
    expect(failingSubscriber.disconnectCalled).toBe(true);
  });

  it("enforces colon-delimited Redis key namespacing conventions", () => {
    expect(
      oddsLatestKey("americanfootball_nfl", "evt-uuid-1"),
    ).toBe("odds:latest:americanfootball_nfl:evt-uuid-1");
    expect(evFeedKey("basketball_nba")).toBe("ev:feed:basketball_nba");
    expect(sgpAuditKey("evt-uuid-1")).toBe("sgp:audit:evt-uuid-1");
    expect(oddsFeedChannel("americanfootball_nfl")).toBe(
      "odds:feed:americanfootball_nfl",
    );
  });
});
