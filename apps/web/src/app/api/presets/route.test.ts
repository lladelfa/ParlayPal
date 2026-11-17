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
  delete process.env.PARLAYPAL_SAMPLE_DATA;
});

describe("GET /api/presets", () => {
  it("returns 3 to 5 curated preset cards when Redis cache is empty (cold start sample fixtures behind dev flag)", async () => {
    process.env.PARLAYPAL_SAMPLE_DATA = "1";
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

  it("handles Redis connection errors gracefully with an honest empty feed", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.shouldFail = true;
    setRedisClientFactory(() => fakeClient);

    const request = new Request("http://localhost:3000/api/presets");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cards).toEqual([]);
    expect(body.reason).toBe("feed_unavailable");
  });

  it("normalizes snake_case worker payloads and falls back to presets:feed:snapshot:all", async () => {
    const fakeClient = new FakeRedisClient();
    const snakeFeed = {
      generated_at: "2026-11-15T19:36:42Z",
      cards: [
        {
          preset_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          title: "Snapshot Express",
          sport_key: "nfl",
          theme_badge: "NFL · 2-Leg Rush",
          combined_decimal_odds: "3.8025",
          combined_american_odds: 280,
          combined_fair_probability: "0.28500",
          combined_ev: "0.0837",
          hybrid_value_score: 90,
          status: "ACTIVE",
          commence_time: "2026-11-16T01:15:00Z",
          legs: [
            {
              prop_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              event_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
              player_name: "Jadarian Price",
              team_abbreviation: "LV",
              matchup: "LV @ SEA",
              market_key: "player_rush_yds",
              market_display: "Under 44.5 Rush Yds",
              selection: "UNDER",
              line_value: "44.50",
              offered_decimal_odds: "1.9500",
              offered_american_odds: -105,
              sharp_decimal_odds: "1.8800",
              sharp_american_odds: -114,
              fair_probability: "0.53000",
              guarded_ev: "0.03350",
              hit_rate_l5: "0.8000",
              hit_rate_l10: "0.7000",
              hit_rate_season: "0.7200",
              hit_rate_display: "7/10 (70.0%) L10",
              sofascore_form: [true, true, false, true, true],
              sofascore_dots: "🟢🟢🔴🟢🟢",
              weather_badge: {
                badge_type: "CLEAR",
                summary: "Clear · 48°F",
                is_threat: false,
              },
              conviction_rationale:
                "Jadarian Price stayed under line in 7 of last 10 games.",
            },
          ],
        },
      ],
    };

    fakeClient.store.set("presets:feed:snapshot:all", JSON.stringify(snakeFeed));
    setRedisClientFactory(() => fakeClient);

    const response = await GET(new Request("http://localhost:3000/api/presets"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.generatedAt).toBe("2026-11-15T19:36:42Z");
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].presetId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(body.cards[0].themeBadge).toBe("NFL · 2-Leg Rush");
    expect(body.cards[0].combinedAmericanOdds).toBe(280);
    expect(body.cards[0].legs[0].playerName).toBe("Jadarian Price");
    expect(body.cards[0].legs[0].lineValue).toBe(44.5);
    expect(body.cards[0].legs[0].weatherBadge).toEqual({
      badgeType: "CLEAR",
      summary: "Clear · 48°F",
      isThreat: false,
    });
  });

  it("passes null hit-rate display through (both key styles) without coercing to empty string", async () => {
    const fakeClient = new FakeRedisClient();
    const mk = (legExtra: Record<string, unknown>) => ({
      generated_at: "2026-11-15T19:36:42Z",
      cards: [
        {
          preset_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          title: "No History",
          sport_key: "nfl",
          theme_badge: "NFL",
          combined_decimal_odds: "3.8025",
          combined_american_odds: 280,
          combined_fair_probability: "0.28500",
          combined_ev: "0.0837",
          hybrid_value_score: 60,
          commence_time: "2026-11-16T01:15:00Z",
          legs: [
            {
              prop_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              player_name: "Null Leg",
              matchup: "A @ B",
              ...legExtra,
            },
          ],
        },
      ],
    });
    setRedisClientFactory(() => fakeClient);

    fakeClient.store.set(
      "presets:feed:all",
      JSON.stringify(mk({ hit_rate_display: null, sofascore_form: [], sofascore_dots: "" })),
    );
    let body = await (await GET(new Request("http://localhost:3000/api/presets"))).json();
    expect(body.cards[0].legs[0].hitRateDisplay).toBeNull();
    expect(body.cards[0].legs[0].sofascoreForm).toEqual([]);

    fakeClient.store.set("presets:feed:all", JSON.stringify(mk({ hitRateDisplay: null })));
    body = await (await GET(new Request("http://localhost:3000/api/presets"))).json();
    expect(body.cards[0].legs[0].hitRateDisplay).toBeNull();

    fakeClient.store.set("presets:feed:all", JSON.stringify(mk({})));
    body = await (await GET(new Request("http://localhost:3000/api/presets"))).json();
    expect(body.cards[0].legs[0].hitRateDisplay).toBeNull();
  });
});
