import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { setRedisClientFactory, userBetsKey, type RedisClient } from "@/lib/redis";

/** Mimics the production client: lazyConnect + no offline queue, so commands fail until connect(). */
class LazyRedisClient implements RedisClient {
  public store = new Map<string, string>();
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertConnected();
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.assertConnected();
    this.store.set(key, value);
    return "OK";
  }

  async quit(): Promise<string> {
    return "OK";
  }

  disconnect(): void {}
}

const USER = "u0000000-0000-4000-8000-000000000001";
const BET_ID = "b0000000-0000-4000-8000-000000000042";

function seededClient(): LazyRedisClient {
  const client = new LazyRedisClient();
  client.store.set(
    userBetsKey(USER),
    JSON.stringify([
      {
        betId: BET_ID,
        userId: USER,
        status: "staged",
        stake: 10,
        combinedDecimalOdds: 3.5,
        legs: [],
      },
    ]),
  );
  return client;
}

afterEach(() => {
  setRedisClientFactory(null);
});

describe("bets routes connect the lazy Redis client", () => {
  it("GET reads persisted bets from Redis", async () => {
    setRedisClientFactory(() => seededClient());
    const res = await GET(new Request(`http://localhost/api/bets?userId=${USER}`));
    const body = await res.json();
    expect(body.bets.map((b: { betId: string }) => b.betId)).toEqual([BET_ID]);
  });

  it("POST persists the new bet to Redis", async () => {
    const client = new LazyRedisClient();
    setRedisClientFactory(() => client);
    const res = await POST(
      new Request("http://localhost/api/bets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": USER },
        body: JSON.stringify({
          userId: USER,
          sportsbook: "FanDuel",
          decimalOdds: 3.0,
          stakeAmount: 25.0,
          legs: [
            {
              propId: "prop-123",
              playerName: "Patrick Mahomes",
              marketDisplay: "Pass Yds Over 274.5",
              line: 274.5,
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              guardedEv: 0.045,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(client.store.has(userBetsKey(USER))).toBe(true);
  });

  it("DELETE removes the bet from Redis", async () => {
    const client = seededClient();
    setRedisClientFactory(() => client);
    const res = await DELETE(
      new Request(`http://localhost/api/bets/${BET_ID}?userId=${USER}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: BET_ID }) },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(client.store.get(userBetsKey(USER)) as string)).toEqual([]);
  });

  it("PATCH finds the bet in Redis instead of returning 404", async () => {
    setRedisClientFactory(() => seededClient());
    const res = await PATCH(
      new Request(`http://localhost/api/bets/${BET_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-user-id": USER },
        body: JSON.stringify({ status: "pending", stake: 12 }),
      }),
      { params: Promise.resolve({ id: BET_ID }) },
    );
    expect(res.status).toBe(200);
  });
});
