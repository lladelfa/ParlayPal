import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { setRedisClientFactory, sgpAuditKey, type RedisClient } from "@/lib/redis";

class FakeRedisClient implements RedisClient {
  public store = new Map<string, string>();
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

describe("POST /api/sgp/price", () => {
  it("returns cached SGP pricing from Redis when cache hit occurs and legs match", async () => {
    const fakeClient = new FakeRedisClient();
    const eventId = "evt-kc-bal";

    const cachedAuditData = {
      event_id: eventId,
      updated_at: new Date().toISOString(),
      audit: {
        eventId: eventId,
        sportKey: "nfl",
        unadjustedFairProbability: "0.25000",
        sgpFairProbability: "0.32000",
        sgpDecimalOdds: "3.6447",
        sgpAmericanOdds: 264,
        hasPositiveSynergy: true,
        correlationAudit: [
          {
            legAPropId: "p1",
            legBPropId: "p2",
            legADescription: "Patrick Mahomes Over Pass Yds",
            legBDescription: "Travis Kelce Over Rec",
            correlationCoefficient: 0.48,
            synergyType: "positive",
            rationale: "Teammates QB Passing + Receiver receptions exhibit strong positive synergy.",
          },
        ],
        isSameGameParlay: true,
        source: "api",
      },
    };

    fakeClient.store.set(sgpAuditKey(eventId), JSON.stringify(cachedAuditData));
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sportKey: "nfl",
        legs: [
          {
            propId: "p1",
            eventId,
            sportKey: "nfl",
            playerName: "Patrick Mahomes",
            teamAbbreviation: "KC",
            marketKey: "player_pass_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
          {
            propId: "p2",
            eventId,
            sportKey: "nfl",
            playerName: "Travis Kelce",
            teamAbbreviation: "KC",
            marketKey: "player_receptions",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.eventId).toBe(eventId);
    expect(body.hasPositiveSynergy).toBe(true);
    expect(body.sgpFairProbability).toBe("0.32000");
    expect(body.correlationAudit.length).toBe(1);
    expect(body.correlationAudit[0].correlationCoefficient).toBe(0.48);
  });

  it("calculates heuristic SGP correlation when Redis cache has different legs", async () => {
    const fakeClient = new FakeRedisClient();
    const eventId = "evt-kc-bal";

    // Cache has props p1 and p2, but request asks for p3 and p4
    const cachedAuditData = {
      event_id: eventId,
      audit: {
        eventId,
        correlationAudit: [
          { legAPropId: "p1", legBPropId: "p2", correlationCoefficient: 0.48 },
        ],
      },
    };
    fakeClient.store.set(sgpAuditKey(eventId), JSON.stringify(cachedAuditData));
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sportKey: "nfl",
        legs: [
          {
            propId: "p3",
            eventId,
            sportKey: "nfl",
            playerName: "Derrick Henry",
            teamAbbreviation: "BAL",
            marketKey: "player_rush_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
          {
            propId: "p4",
            eventId,
            sportKey: "nfl",
            playerName: "Isiah Pacheco",
            teamAbbreviation: "KC",
            marketKey: "player_rush_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("heuristic");
    expect(body.correlationAudit[0].legAPropId).toBe("p3");
  });

  it("calculates heuristic SGP correlation when Redis cache is empty", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const eventId = "evt-nba-bos";
    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sportKey: "nba",
        legs: [
          {
            propId: "p_jrue",
            eventId,
            sportKey: "nba",
            playerName: "Jrue Holiday",
            teamAbbreviation: "BOS",
            marketKey: "player_assists",
            selection: "OVER",
            offeredDecimalOdds: "1.8500",
            fairProbability: "0.52000",
          },
          {
            propId: "p_tatum",
            eventId,
            sportKey: "nba",
            playerName: "Jayson Tatum",
            teamAbbreviation: "BOS",
            marketKey: "player_points",
            selection: "OVER",
            offeredDecimalOdds: "1.9000",
            fairProbability: "0.51000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.eventId).toBe(eventId);
    expect(body.hasPositiveSynergy).toBe(true);
    expect(body.source).toBe("heuristic");
    expect(body.correlationAudit.length).toBe(1);
    expect(body.correlationAudit[0].correlationCoefficient).toBeGreaterThan(0);
  });

  it("handles negative cannibalization gracefully with neutral synergy state", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const eventId = "evt-nfl-opposing";
    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sportKey: "nfl",
        legs: [
          {
            propId: "p_rb1",
            eventId,
            sportKey: "nfl",
            playerName: "Derrick Henry",
            teamAbbreviation: "BAL",
            marketKey: "player_rush_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
          {
            propId: "p_rb2",
            eventId,
            sportKey: "nfl",
            playerName: "Isiah Pacheco",
            teamAbbreviation: "KC",
            marketKey: "player_rush_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasPositiveSynergy).toBe(false);
    expect(body.correlationAudit.length).toBe(1);
    expect(body.correlationAudit[0].correlationCoefficient).toBeLessThan(0);
  });

  it("handles Redis offline failure gracefully by falling back to heuristic without 500 error", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.shouldFail = true;
    setRedisClientFactory(() => fakeClient);

    const eventId = "evt-kc-bal";
    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        sportKey: "nfl",
        legs: [
          {
            propId: "p1",
            eventId,
            sportKey: "nfl",
            playerName: "Patrick Mahomes",
            teamAbbreviation: "KC",
            marketKey: "player_pass_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
          {
            propId: "p2",
            eventId,
            sportKey: "nfl",
            playerName: "Travis Kelce",
            teamAbbreviation: "KC",
            marketKey: "player_receptions",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.eventId).toBe(eventId);
    expect(body.source).toBe("heuristic");
    expect(body.hasPositiveSynergy).toBe(true);
  });

  it("rejects request when legs has fewer than 2 selections", async () => {
    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-1",
        sportKey: "nfl",
        legs: [
          {
            propId: "p1",
            eventId: "evt-1",
            sportKey: "nfl",
            playerName: "Patrick Mahomes",
            teamAbbreviation: "KC",
            marketKey: "player_pass_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe("INVALID_SGP_LEGS");
  });

  it("rejects request when legs have mismatched eventIds", async () => {
    const req = new Request("http://localhost:3000/api/sgp/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-1",
        sportKey: "nfl",
        legs: [
          {
            propId: "p1",
            eventId: "evt-1",
            sportKey: "nfl",
            playerName: "Patrick Mahomes",
            teamAbbreviation: "KC",
            marketKey: "player_pass_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
          {
            propId: "p2",
            eventId: "evt-2",
            sportKey: "nfl",
            playerName: "Lamar Jackson",
            teamAbbreviation: "BAL",
            marketKey: "player_pass_yds",
            selection: "OVER",
            offeredDecimalOdds: "1.9091",
            fairProbability: "0.50000",
          },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe("EVENT_ID_MISMATCH");
  });
});

describe("GET /api/sgp/price", () => {
  it("returns 400 when eventId query param is missing", async () => {
    const req = new Request("http://localhost:3000/api/sgp/price");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe("MISSING_EVENT_ID");
  });

  it("returns 404 when no SGP audit is cached for the eventId", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/sgp/price?eventId=evt-not-found");
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe("SGP_AUDIT_NOT_FOUND");
  });

  it("returns 200 with normalized camelCase SgpPriceResponse when audit is cached", async () => {
    const fakeClient = new FakeRedisClient();
    const eventId = "evt-cached-get";
    const cachedData = {
      event_id: eventId,
      updated_at: "2026-11-10T00:00:00Z",
      audit: {
        event_id: eventId,
        sport_key: "americanfootball_nfl",
        unadjusted_fair_probability: "0.25000",
        sgp_fair_probability: "0.32000",
        sgp_decimal_odds: "3.6447",
        sgp_american_odds: 264,
        has_positive_synergy: true,
        correlation_audit: [
          {
            leg_a_prop_id: "p1",
            leg_b_prop_id: "p2",
            leg_1: "Mahomes Pass Yds",
            leg_2: "Kelce Rec",
            correlation_coefficient: 0.48,
            impact: "positive_correlation",
            rationale: "Strong synergy",
          },
        ],
        source: "api",
      },
    };

    fakeClient.store.set(sgpAuditKey(eventId), JSON.stringify(cachedData));
    setRedisClientFactory(() => fakeClient);

    const req = new Request(`http://localhost:3000/api/sgp/price?eventId=${eventId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.eventId).toBe(eventId);
    expect(body.sportKey).toBe("americanfootball_nfl");
    expect(body.sgpFairProbability).toBe("0.32000");
    expect(body.unadjustedFairProbability).toBe("0.25000");
    expect(body.hasPositiveSynergy).toBe(true);
    expect(body.isSameGameParlay).toBe(true);
    expect(body.correlationAudit.length).toBe(1);
    expect(body.correlationAudit[0].legAPropId).toBe("p1");
    expect(body.correlationAudit[0].correlationCoefficient).toBe(0.48);
    expect(body.correlationAudit[0].synergyType).toBe("positive");
  });

  it("returns 500 when Redis throws a connection failure during GET", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.shouldFail = true;
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/sgp/price?eventId=evt-err");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe("REDIS_ERROR");
  });
});
