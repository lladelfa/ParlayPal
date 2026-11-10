import { describe, expect, it } from "vitest";
import { POST } from "./route";

function createMockLeg(
  propId: string,
  playerName: string,
  overrides?: Record<string, any>,
) {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey: "player_anytime_td",
    marketDisplay: "Anytime Touchdown",
    selection: "OVER",
    line: 0.5,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    guardedEv: "0.0200",
    ...overrides,
  };
}

describe("POST /api/bets/stage", () => {
  it("returns HTTP 200 with staged bet payload for multi-leg parlay (Happy Path)", async () => {
    const leg1 = createMockLeg("leg-henry", "Derrick Henry", {
      line: 0.5,
      offeredDecimalOdds: 2.08,
      offeredAmericanOdds: 108,
    });
    const leg2 = createMockLeg("leg-amon", "Amon-Ra St. Brown", {
      marketDisplay: "Receptions Over 6.5",
      line: 6.5,
      offeredDecimalOdds: 2.5,
      offeredAmericanOdds: 150,
    });
    const leg3 = createMockLeg("leg-mahomes", "Patrick Mahomes", {
      marketDisplay: "Pass Yds Over 274.5",
      line: 274.5,
      offeredDecimalOdds: 1.91,
      offeredAmericanOdds: -110,
    });

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg1, leg2, leg3],
        sportsbook: "fanduel",
        stake: 50,
        decimalOdds: 9.93,
        americanOdds: 893,
        quickpickUrl: "https://quickpick.pikkit.com/v1/betslip?data=xyz",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("staged");
    expect(body.betId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(body.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.sportsbook).toBe("fanduel");
    expect(body.legs).toHaveLength(3);
    expect(body.stakeAmount).toBe(50);
    expect(body.decimalOdds).toBe(9.93);
    expect(body.potentialPayout).toBe(496.5);
    expect(body.quickpickUrl).toBe("https://quickpick.pikkit.com/v1/betslip?data=xyz");
    expect(body.stagedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns HTTP 200 for single-leg bet handoff staging", async () => {
    const leg = createMockLeg("leg-henry", "Derrick Henry");

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "draftkings",
        stake: 25,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("staged");
    expect(body.sportsbook).toBe("draftkings");
    expect(body.legs).toHaveLength(1);
    expect(body.stakeAmount).toBe(25);
  });

  it("supports guest/unauthenticated bettor by generating a valid guest UUID userId", async () => {
    const leg = createMockLeg("leg-luka", "Luka Doncic");

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "betmgm",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userId).toBeDefined();
    expect(body.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("preserves explicit userId and betId if provided in request", async () => {
    const leg = createMockLeg("leg-1", "Player 1");
    const customBetId = "11111111-1111-4111-8111-111111111111";
    const customUserId = "22222222-2222-4222-8222-222222222222";

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        betId: customBetId,
        userId: customUserId,
        legs: [leg],
        sportsbook: "caesars",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.betId).toBe(customBetId);
    expect(body.userId).toBe(customUserId);
  });

  it("returns HTTP 400 when parlay legs are empty (EMPTY_PARLAY_LEGS)", async () => {
    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [],
        sportsbook: "fanduel",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("EMPTY_PARLAY_LEGS");
  });

  it("returns HTTP 400 when missing sportsbook (MISSING_REQUIRED_FIELDS)", async () => {
    const leg = createMockLeg("leg-1", "Player 1");
    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("MISSING_REQUIRED_FIELDS");
  });

  it("returns HTTP 400 when exceeding 8 legs (MAX_LEGS_EXCEEDED)", async () => {
    const legs = Array.from({ length: 9 }, (_, i) =>
      createMockLeg(`leg-${i + 1}`, `Player ${i + 1}`),
    );

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs,
        sportsbook: "fanduel",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("MAX_LEGS_EXCEEDED");
  });

  it("returns HTTP 400 when leg has invalid decimal odds < 1.01 (INVALID_ODDS)", async () => {
    const leg = createMockLeg("leg-bad-odds", "Player Bad Odds", {
      offeredDecimalOdds: 1.005,
    });

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "fanduel",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ODDS");
  });

  it("returns HTTP 400 when leg has non-numeric, missing, or > 9999.9999 odds (INVALID_ODDS)", async () => {
    const legMissingOdds = createMockLeg("leg-missing-odds", "Player Missing Odds", {
      offeredDecimalOdds: undefined,
      odds: undefined,
      decimalOdds: undefined,
    });

    const req1 = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [legMissingOdds],
        sportsbook: "fanduel",
      }),
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(400);
    expect((await res1.json()).error.code).toBe("INVALID_ODDS");

    const legHugeOdds = createMockLeg("leg-huge", "Player Huge", {
      offeredDecimalOdds: 10000,
    });
    const req2 = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [legHugeOdds],
        sportsbook: "fanduel",
      }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(400);
    expect((await res2.json()).error.code).toBe("INVALID_ODDS");
  });

  it("returns HTTP 400 when stake is non-positive or non-finite (INVALID_LEG_DATA)", async () => {
    const leg = createMockLeg("leg-stake", "Player Stake");

    for (const badStake of [0, -10, NaN, "not-a-number"]) {
      const req = new Request("http://localhost:3000/api/bets/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legs: [leg],
          sportsbook: "fanduel",
          stake: badStake,
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_LEG_DATA");
    }
  });

  it("returns HTTP 400 when leg has suspect stale line EV > 10.0% (SUSPECT_STALE_LINE)", async () => {
    const leg = createMockLeg("leg-stale", "Player Stale", {
      guardedEv: 0.125, // 12.5% > 10%
    });

    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: [leg],
        sportsbook: "fanduel",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("SUSPECT_STALE_LINE");
  });

  it("returns HTTP 400 when leg is missing required fields (INVALID_LEG_DATA)", async () => {
    const badLeg = {
      playerName: "Missing Prop ID and Selection",
    };

    const req = new Request("http://localhost:3000/api/bets/stage", {
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
  });

  it("returns HTTP 400 when request body is not valid JSON", async () => {
    const req = new Request("http://localhost:3000/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LEG_DATA");
  });
});
