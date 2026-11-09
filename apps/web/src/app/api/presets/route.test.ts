import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { setRedisClientFactory, type RedisClient } from "@/lib/redis";

class FakeRedisClient implements RedisClient {
  public store = new Map<string, string>();
  public connected = false;
  public shouldFail = false;

  async get(key: string): Promise<string | null> {
    if (this.shouldFail) {
      throw new Error("Redis connection failure");
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: unknown[]): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }

  async quit(): Promise<string> {
    return "OK";
  }

  disconnect(): void {}
}

afterEach(() => {
  setRedisClientFactory(null);
});

describe("GET /api/presets", () => {
  it("returns 3 to 5 curated preset cards when Redis cache is empty (cold start fallback)", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const request = new Request("http://localhost:3000/api/presets");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toHaveProperty("cards");
    expect(Array.isArray(body.cards)).toBe(true);
    expect(body.cards.length).toBeGreaterThanOrEqual(3);
    expect(body.cards.length).toBeLessThanOrEqual(5);

    for (const card of body.cards) {
      expect(card).toHaveProperty("presetId");
      expect(card).toHaveProperty("title");
      expect(card).toHaveProperty("themeBadge");
      expect(card).toHaveProperty("combinedAmericanOdds");
      expect(card).toHaveProperty("combinedDecimalOdds");
      expect(card).toHaveProperty("combinedEv");
      expect(card).toHaveProperty("hybridValueScore");
      expect(card.hybridValueScore).toBeGreaterThanOrEqual(0);
      expect(card.hybridValueScore).toBeLessThanOrEqual(100);

      expect(card.legs.length).toBeGreaterThanOrEqual(2);
      expect(card.legs.length).toBeLessThanOrEqual(4);

      for (const leg of card.legs) {
        expect(leg).toHaveProperty("playerName");
        expect(leg).toHaveProperty("matchup");
        expect(leg).toHaveProperty("marketDisplay");
        expect(leg).toHaveProperty("hitRateDisplay");
        expect(leg).toHaveProperty("sofascoreDots");
        expect(leg).toHaveProperty("convictionRationale");
        expect(leg.convictionRationale.length).toBeGreaterThan(5);
      }
    }
  });

  it("serves cached preset cards from Redis when available", async () => {
    const fakeClient = new FakeRedisClient();
    const mockFeed = {
      generatedAt: new Date().toISOString(),
      cards: [
        {
          presetId: "11111111-1111-1111-1111-111111111111",
          title: "The Red Zone Express",
          sportKey: "nfl",
          themeBadge: "NFL · 2-Leg Anytime TD",
          combinedDecimalOdds: "3.7800",
          combinedAmericanOdds: 278,
          combinedFairProbability: "0.29580",
          combinedEv: "0.1181",
          hybridValueScore: 88,
          status: "ACTIVE",
          commenceTime: new Date(Date.now() + 3600000).toISOString(),
          legs: [
            {
              propId: "22222222-2222-2222-2222-222222222222",
              eventId: "33333333-3333-3333-3333-333333333333",
              playerName: "Derrick Henry",
              teamAbbreviation: "BAL",
              matchup: "BAL @ PIT",
              marketKey: "player_anytime_td",
              marketDisplay: "Anytime Touchdown",
              selection: "OVER",
              lineValue: 0.5,
              offeredDecimalOdds: "1.8000",
              offeredAmericanOdds: -125,
              sharpDecimalOdds: "1.7500",
              sharpAmericanOdds: -133,
              fairProbability: "0.5800",
              guardedEv: "0.0440",
              hitRateL10: "0.7000",
              hitRateDisplay: "7/10 (70.0%) L10",
              sofascoreForm: [true, true, false, true, true],
              sofascoreDots: "🟢🟢🔴🟢🟢",
              weatherBadge: null,
              convictionRationale: "Henry has scored in 7 of last 10 games.",
            },
            {
              propId: "44444444-4444-4444-4444-444444444444",
              eventId: "55555555-5555-5555-5555-555555555555",
              playerName: "CeeDee Lamb",
              teamAbbreviation: "DAL",
              matchup: "DAL @ PHI",
              marketKey: "player_anytime_td",
              marketDisplay: "Anytime Touchdown",
              selection: "OVER",
              lineValue: 0.5,
              offeredDecimalOdds: "2.1000",
              offeredAmericanOdds: 110,
              sharpDecimalOdds: "2.0000",
              sharpAmericanOdds: 100,
              fairProbability: "0.5100",
              guardedEv: "0.0710",
              hitRateL10: "0.7000",
              hitRateDisplay: "7/10 (70.0%) L10",
              sofascoreForm: [true, false, true, true, true],
              sofascoreDots: "🟢🔴🟢🟢🟢",
              weatherBadge: null,
              convictionRationale: "Lamb has scored in 7 of last 10 games.",
            },
          ],
        },
      ],
    };

    fakeClient.store.set("presets:feed:all", JSON.stringify(mockFeed));
    setRedisClientFactory(() => fakeClient);

    const request = new Request("http://localhost:3000/api/presets");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards[0].title).toBe("The Red Zone Express");
    expect(body.cards[0].legs[0].playerName).toBe("Derrick Henry");
  });

  it("handles Redis connection errors gracefully by falling back to curated feed", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.shouldFail = true;
    setRedisClientFactory(() => fakeClient);

    const request = new Request("http://localhost:3000/api/presets");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards.length).toBeGreaterThanOrEqual(3);
  });
});
