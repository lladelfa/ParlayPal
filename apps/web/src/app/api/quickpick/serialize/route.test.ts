import { describe, expect, it } from "vitest";
import { POST } from "./route";

function createMockLeg(
  propId: string,
  playerName: string,
  marketKey: string = "player_anytime_td",
  overrides?: Record<string, any>,
) {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey,
    marketDisplay: "Anytime Touchdown",
    selection: "OVER",
    lineValue: 0.5,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    fairProbability: "0.50000",
    guardedEv: "0.0200",
    ...overrides,
  };
}

describe("POST /api/quickpick/serialize", () => {
  it("returns HTTP 200 with valid QuickPick smart link and deep link for multi-leg parlay (Happy Path)", async () => {
    const leg1 = createMockLeg("leg-henry", "Derrick Henry", "player_anytime_td", {
      lineValue: 0.5,
      offeredDecimalOdds: "2.0800",
      offeredAmericanOdds: 108,
    });
    const leg2 = createMockLeg("leg-amon", "Amon-Ra St. Brown", "player_receptions", {
      lineValue: 6.5,
      offeredDecimalOdds: "2.5000",
      offeredAmericanOdds: 150,
    });

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg1, leg2],
        sportsbook: "fanduel",
        stake: 50,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/quickpick\.pikkit\.com\/v1\/betslip\?data=/);
    expect(body.universalLink).toBe(body.url);
    expect(body.deepLink).toMatch(/^fanduel:\/\/sportsbook\/betslip\?quickpick=/);
    expect(body.fallbackUrl).toBe("https://sportsbook.fanduel.com");
    expect(body.encodedData).toBeTruthy();
    expect(body.payload.legs).toHaveLength(2);
    expect(body.payload.sportsbook).toBe("fanduel");
    expect(body.payload.stake).toBe(50);

    // Verify sub-1500ms latency requirement (target < 100ms)
    expect(body.executionLatencyMs).toBeDefined();
    expect(body.executionLatencyMs).toBeLessThan(1500);
    expect(res.headers.get("Server-Timing")).toContain("serialize;dur=");
  });

  it("returns HTTP 200 for single-leg bet on DraftKings", async () => {
    const leg = createMockLeg("leg-luka", "Luka Doncic", "player_points", {
      eventId: "papi_nba_3001",
      sportKey: "nba",
      lineValue: 31.5,
      offeredDecimalOdds: "1.9091",
    });

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "draftkings",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/quickpick\.pikkit\.com\/v1\/betslip\?data=/);
    expect(body.deepLink).toMatch(/^draftkings:\/\/sportsbook\/betslip\?quickpick=/);
    expect(body.payload.legs).toHaveLength(1);
    expect(body.payload.legs[0].playerName).toBe("Luka Doncic");
  });

  it("returns HTTP 400 when parlay legs are empty (EMPTY_PARLAY_LEGS)", async () => {
    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [],
        sportsbook: "betmgm",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "EMPTY_PARLAY_LEGS",
        message: "At least one leg is required.",
      },
    });
  });

  it("returns HTTP 400 when targeting an unsupported sportsbook (UNSUPPORTED_SPORTSBOOK)", async () => {
    const leg1 = createMockLeg("leg-1", "Patrick Mahomes");
    const leg2 = createMockLeg("leg-2", "Travis Kelce");

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg1, leg2],
        sportsbook: "unsupported_book",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "UNSUPPORTED_SPORTSBOOK",
        message: "Sportsbook 'unsupported_book' is not supported.",
      },
    });
  });

  it("returns HTTP 400 when exceeding maximum allowed 8 legs (MAX_LEGS_EXCEEDED)", async () => {
    const legs = Array.from({ length: 9 }, (_, i) =>
      createMockLeg(`leg-${i + 1}`, `Player ${i + 1}`),
    );

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs,
        sportsbook: "caesars",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "MAX_LEGS_EXCEEDED",
        message: "Maximum 8 legs allowed per QuickPick slip.",
      },
    });
  });

  it("returns HTTP 400 when leg payload is malformed (missing propId or marketKey)", async () => {
    const badLeg = {
      playerName: "Missing Prop ID",
      marketKey: "player_pass_yds",
      selection: "OVER",
    };

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [badLeg],
        sportsbook: "fanduel",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LEG_DATA");
    expect(body.error.message).toContain("missing required field: propId");
  });

  it("returns HTTP 400 when request body is malformed JSON", async () => {
    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LEG_DATA");
    expect(body.error.message).toBe("Request body must be valid JSON.");
  });

  it("allows unauthenticated guest access without authorization headers or session cookies", async () => {
    const leg = createMockLeg("leg-guest", "Lamar Jackson");

    const req = new Request("http://localhost:3000/api/quickpick/serialize", {
      method: "POST",
      // Notice: No Authorization or Cookie headers
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "fanatics",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.payload.sportsbook).toBe("fanatics");
    expect(body.deepLink).toContain("fanatics://");
  });
});
