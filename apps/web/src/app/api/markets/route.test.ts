import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { setRedisClientFactory, type RedisClient } from "@/lib/redis";

class FakeRedisClient implements RedisClient {
  public store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
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

beforeEach(() => {
  setRedisClientFactory(() => new FakeRedisClient());
});

afterEach(() => {
  setRedisClientFactory(null);
});

describe("GET /api/markets", () => {
  it("returns 200 with complete market feed", async () => {
    const req = new Request("http://localhost:3000/api/markets");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("props");
    expect(data).toHaveProperty("games");
    expect(Array.isArray(data.props)).toBe(true);
    expect(data.props.length).toBeGreaterThan(0);
  });

  it("filters by sport and market query parameters", async () => {
    const req = new Request("http://localhost:3000/api/markets?sport=nba&market=player_points");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.props.every((p: { sportKey: string; marketKey: string }) => p.sportKey === "nba" && p.marketKey === "player_points")).toBe(true);
  });

  it("filters by search query", async () => {
    const req = new Request("http://localhost:3000/api/markets?q=curry");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.props.length).toBe(1);
    expect(data.props[0].playerName).toBe("Stephen Curry");
  });

  it("coerces string lineValue and falls back to markets:browser:snapshot:all", async () => {
    const fakeClient = new FakeRedisClient();
    const snapshotFeed = {
      generatedAt: "2026-11-15T19:36:42Z",
      sportKey: "all",
      games: [
        {
          eventId: "11111111-1111-1111-1111-111111111111",
          sportKey: "nba",
          matchup: "HOU @ WAS",
          homeTeamAbbreviation: "WAS",
          awayTeamAbbreviation: "HOU",
          commenceTime: "2026-11-16T00:00:00Z",
          dateWindow: "today",
          propCount: 1,
          topHybridValueScore: 87,
        },
      ],
      props: [
        {
          propId: "22222222-2222-2222-2222-222222222222",
          eventId: "11111111-1111-1111-1111-111111111111",
          sportKey: "nba",
          playerName: "Trae Young",
          teamAbbreviation: "WAS",
          matchup: "HOU @ WAS",
          commenceTime: "2026-11-16T00:00:00Z",
          dateWindow: "today",
          marketKey: "player_points",
          marketLabel: "Points",
          marketDisplay: "Over 26.5 Points",
          selection: "OVER",
          lineValue: "26.50",
          offeredDecimalOdds: "1.9500",
          offeredAmericanOdds: -105,
          sharpDecimalOdds: "1.9000",
          sharpAmericanOdds: -111,
          fairProbability: "0.53000",
          guardedEv: "0.03350",
          hitRateL5: "0.8000",
          hitRateL10: "0.7000",
          hitRateSeason: "0.7400",
          hitRateDisplay: "7/10 (70.0%) L10",
          sofascoreForm: [true, true, false, true, true],
          sofascoreDots: "🟢🟢🔴🟢🟢",
          weatherBadge: {
            badgeType: "DOME",
            summary: "DOME Indoor",
            isThreat: false,
          },
          hybridValueScore: 87,
          status: "ACTIVE",
          valueTier: "HIGH_VALUE",
          isHighValue: true,
        },
      ],
    };

    fakeClient.store.set("markets:browser:snapshot:all", JSON.stringify(snapshotFeed));
    setRedisClientFactory(() => fakeClient);

    const res = await GET(new Request("http://localhost:3000/api/markets"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.props).toHaveLength(1);
    expect(data.props[0].playerName).toBe("Trae Young");
    expect(data.props[0].lineValue).toBe(26.5);
    expect(typeof data.props[0].lineValue).toBe("number");
    expect(data.games).toHaveLength(1);
  });
});
