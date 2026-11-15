import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { setRedisClientFactory, userBetsKey, type RedisClient } from "@/lib/redis";
import type { TrackedBet } from "@/types/bet";

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
    if (this.shouldFail) {
      throw new Error("Redis connection failure");
    }
    this.store.set(key, value);
    return "OK";
  }

  async quit(): Promise<string> {
    return "OK";
  }

  disconnect(): void {}
}

describe("REST API /api/bets and /api/bets/[id]", () => {
  afterEach(() => {
    setRedisClientFactory(null);
  });

  const sampleLeg = {
    propId: "prop-123",
    playerName: "Patrick Mahomes",
    marketDisplay: "Pass Yds Over 274.5",
    line: 274.5,
    selection: "OVER",
    offeredDecimalOdds: 1.91,
    guardedEv: 0.045,
  };

  const sampleBet: TrackedBet = {
    betId: "b0000000-0000-4000-8000-000000000001",
    userId: "u0000000-0000-4000-8000-000000000001",
    sportsbook: "DraftKings",
    decimalOdds: 3.5,
    americanOdds: 250,
    stakeAmount: 50,
    potentialPayout: 175,
    status: "staged",
    legs: [sampleLeg],
    stagedAt: "2026-11-10T12:00:00.000Z",
  };

  it("GET /api/bets returns 200 with empty bets and metrics when no bets exist", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/bets?userId=test-user");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bets).toEqual([]);
    expect(body.metrics.totalBets).toBe(0);
  });

  it("GET /api/bets handles Redis failure gracefully with 200 fallback", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.shouldFail = true;
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/bets?userId=test-user");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bets).toEqual([]);
  });

  it("GET /api/bets filters tickets by status", async () => {
    const fakeClient = new FakeRedisClient();
    const userId = "u0000000-0000-4000-8000-000000000001";
    const stagedBet: TrackedBet = { ...sampleBet, betId: "bet-1", status: "staged" };
    const pendingBet: TrackedBet = { ...sampleBet, betId: "bet-2", status: "pending" };
    const wonBet: TrackedBet = { ...sampleBet, betId: "bet-3", status: "won" };

    fakeClient.store.set(userBetsKey(userId), JSON.stringify([stagedBet, pendingBet, wonBet]));
    setRedisClientFactory(() => fakeClient);

    // Filter staged
    const resStaged = await GET(new Request(`http://localhost:3000/api/bets?userId=${userId}&status=staged`));
    const bodyStaged = await resStaged.json();
    expect(bodyStaged.bets).toHaveLength(1);
    expect(bodyStaged.bets[0].betId).toBe("bet-1");

    // Filter pending
    const resPending = await GET(new Request(`http://localhost:3000/api/bets?userId=${userId}&status=pending`));
    const bodyPending = await resPending.json();
    expect(bodyPending.bets).toHaveLength(1);
    expect(bodyPending.bets[0].betId).toBe("bet-2");

    // Filter won
    const resWon = await GET(new Request(`http://localhost:3000/api/bets?userId=${userId}&status=won`));
    const bodyWon = await resWon.json();
    expect(bodyWon.bets).toHaveLength(1);
    expect(bodyWon.bets[0].betId).toBe("bet-3");
  });

  it("POST /api/bets creates a bet successfully", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/bets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sportsbook: "FanDuel",
        decimalOdds: 3.0,
        stakeAmount: 25.0,
        legs: [sampleLeg],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bet.sportsbook).toBe("FanDuel");
    expect(body.bet.stakeAmount).toBe(25.0);
    expect(body.bet.potentialPayout).toBe(75.0);
    expect(body.bet.betId).toBeDefined();
    expect(body.bet.userId).toBeDefined();
  });

  it("POST /api/bets validates empty legs, invalid odds, stake <= 0, and suspect stale line EV", async () => {
    // Empty legs
    const resEmpty = await POST(new Request("http://localhost:3000/api/bets", {
      method: "POST",
      body: JSON.stringify({ sportsbook: "FanDuel", legs: [] }),
    }));
    expect(resEmpty.status).toBe(400);

    // Invalid odds < 1.01
    const resOdds = await POST(new Request("http://localhost:3000/api/bets", {
      method: "POST",
      body: JSON.stringify({
        sportsbook: "FanDuel",
        decimalOdds: 0.9,
        legs: [{ ...sampleLeg, offeredDecimalOdds: 0.9 }],
      }),
    }));
    expect(resOdds.status).toBe(400);

    // Stake <= 0
    const resStake = await POST(new Request("http://localhost:3000/api/bets", {
      method: "POST",
      body: JSON.stringify({
        sportsbook: "FanDuel",
        stakeAmount: 0,
        legs: [sampleLeg],
      }),
    }));
    expect(resStake.status).toBe(400);
    const bodyStake = await resStake.json();
    expect(bodyStake.error.message).toMatch(/Stake must be greater than \$0\.00/);

    // Suspect stale line EV > 10.0%
    const resStale = await POST(new Request("http://localhost:3000/api/bets", {
      method: "POST",
      body: JSON.stringify({
        sportsbook: "FanDuel",
        legs: [{ ...sampleLeg, guardedEv: 0.15 }],
      }),
    }));
    expect(resStale.status).toBe(400);
    const bodyStale = await resStale.json();
    expect(bodyStale.error.code).toBe("SUSPECT_STALE_LINE");
  });

  it("PATCH /api/bets/[id] transitions staged bet to pending with confirmed stake", async () => {
    const fakeClient = new FakeRedisClient();
    const userId = sampleBet.userId;
    fakeClient.store.set(userBetsKey(userId), JSON.stringify([sampleBet]));
    setRedisClientFactory(() => fakeClient);

    const req = new Request(`http://localhost:3000/api/bets/${sampleBet.betId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        status: "pending",
        stakeAmount: 35.0,
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: sampleBet.betId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.bet.status).toBe("pending");
    expect(body.bet.stakeAmount).toBe(35.0);
    expect(body.bet.potentialPayout).toBe(122.5); // 35 * 3.5
  });

  it("PATCH /api/bets/[id] rejects invalid stake <= 0", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const req = new Request(`http://localhost:3000/api/bets/${sampleBet.betId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stakeAmount: -10,
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: sampleBet.betId }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Stake must be greater than \$0\.00/);
  });

  it("PATCH /api/bets/[id] settles bet and prevents re-settling finalized bet", async () => {
    const fakeClient = new FakeRedisClient();
    const userId = sampleBet.userId;
    const pendingBet: TrackedBet = { ...sampleBet, status: "pending" };
    fakeClient.store.set(userBetsKey(userId), JSON.stringify([pendingBet]));
    setRedisClientFactory(() => fakeClient);

    // Settle to won
    const req1 = new Request(`http://localhost:3000/api/bets/${sampleBet.betId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        status: "won",
      }),
    });
    const res1 = await PATCH(req1, { params: Promise.resolve({ id: sampleBet.betId }) });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.bet.status).toBe("won");
    expect(body1.bet.settledAt).toBeDefined();

    // Attempting to re-settle should return 400
    const req2 = new Request(`http://localhost:3000/api/bets/${sampleBet.betId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        status: "lost",
      }),
    });
    const res2 = await PATCH(req2, { params: Promise.resolve({ id: sampleBet.betId }) });
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.error.code).toBe("ALREADY_SETTLED");
  });

  it("PATCH /api/bets/[id] returns 404 when bet is not found", async () => {
    const fakeClient = new FakeRedisClient();
    setRedisClientFactory(() => fakeClient);

    const req = new Request("http://localhost:3000/api/bets/non-existent-bet-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "test-user",
        status: "pending",
      }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "non-existent-bet-id" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("DELETE /api/bets/[id] removes bet from store", async () => {
    const fakeClient = new FakeRedisClient();
    const userId = sampleBet.userId;
    fakeClient.store.set(userBetsKey(userId), JSON.stringify([sampleBet]));
    setRedisClientFactory(() => fakeClient);

    const req = new Request(`http://localhost:3000/api/bets/${sampleBet.betId}?userId=${userId}`, {
      method: "DELETE",
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: sampleBet.betId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.betId).toBe(sampleBet.betId);

    // Verify removed
    const stored = JSON.parse(fakeClient.store.get(userBetsKey(userId)) || "[]");
    expect(stored).toHaveLength(0);
  });

  describe("CLV Benchmark Persistence, Validation & Analytics Metrics", () => {
    it("GET /api/bets returns CLV analytics and edge distribution metrics while excluding staged and >10% outliers", async () => {
      const fakeClient = new FakeRedisClient();
      const userId = "u0000000-0000-4000-8000-000000000099";
      const bets: TrackedBet[] = [
        {
          ...sampleBet,
          betId: "clv-api-1",
          userId,
          sportsbook: "FanDuel",
          status: "pending",
          stakeAmount: 50,
          clvPercentage: 4.0,
          legs: [{ ...sampleLeg, sportKey: "nfl", marketKey: "player_pass_yds" }],
        },
        {
          ...sampleBet,
          betId: "clv-api-2",
          userId,
          sportsbook: "DraftKings",
          status: "won",
          stakeAmount: 25,
          clvPercentage: 2.0,
          legs: [
            { ...sampleLeg, sportKey: "nfl", marketKey: "player_pass_yds" },
            {
              propId: "nba-1",
              playerName: "Nikola Jokic",
              marketDisplay: "Points Over 26.5",
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              sportKey: "nba",
              marketKey: "player_points",
            },
          ],
        },
        {
          ...sampleBet,
          betId: "clv-api-3",
          userId,
          sportsbook: "BetMGM",
          status: "lost",
          stakeAmount: 25,
          clvPercentage: -3.0,
          legs: [
            {
              propId: "nba-2",
              playerName: "Jayson Tatum",
              marketDisplay: "Points Over 27.5",
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              sportKey: "nba",
              marketKey: "player_points",
            },
          ],
        },
        {
          ...sampleBet,
          betId: "clv-api-staged",
          userId,
          status: "staged",
          stakeAmount: 100,
          clvPercentage: 5.0,
        },
        {
          ...sampleBet,
          betId: "clv-api-outlier",
          userId,
          status: "won",
          stakeAmount: 100,
          clvPercentage: 12.5,
        },
      ];

      fakeClient.store.set(userBetsKey(userId), JSON.stringify(bets));
      setRedisClientFactory(() => fakeClient);

      const res = await GET(new Request(`http://localhost:3000/api/bets?userId=${userId}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.metrics.clvTrackedCount).toBe(3);
      expect(body.metrics.clvBeatCount).toBe(2);
      expect(body.metrics.closingLineBeatRate).toBe(66.67);
      expect(body.metrics.averageClvPercentage).toBe(1.75);
      expect(body.metrics.unweightedAverageClvPercentage).toBe(1);
      expect(body.metrics.bySport.map((b: { label: string }) => b.label)).toEqual([
        "NFL",
        "NBA",
        "Multi-Sport",
      ]);
      expect(body.metrics.bySportsbook).toHaveLength(3);
    });

    it("POST /api/bets persists and quantizes valid optional CLV fields", async () => {
      const fakeClient = new FakeRedisClient();
      setRedisClientFactory(() => fakeClient);

      const req = new Request("http://localhost:3000/api/bets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user-clv-post",
          sportsbook: "FanDuel",
          decimalOdds: 2.5,
          stakeAmount: 50,
          legs: [sampleLeg],
          closingDecimalOdds: 2.381234,
          closingFairProb: 0.421234,
          clvPercentage: 5.3085,
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.bet.closingDecimalOdds).toBe(2.3812);
      expect(body.bet.closingFairProb).toBe(0.42123);
      expect(body.bet.clvPercentage).toBe(5.309);
    });

    it("POST /api/bets rejects clvPercentage > 10.0 with SUSPECT_STALE_LINE and invalid CLV with INVALID_CLV", async () => {
      const fakeClient = new FakeRedisClient();
      setRedisClientFactory(() => fakeClient);

      const resSuspect = await POST(
        new Request("http://localhost:3000/api/bets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sportsbook: "FanDuel",
            decimalOdds: 2.5,
            stakeAmount: 50,
            legs: [sampleLeg],
            clvPercentage: 12.5,
          }),
        }),
      );
      expect(resSuspect.status).toBe(400);
      const bodySuspect = await resSuspect.json();
      expect(bodySuspect.error.code).toBe("SUSPECT_STALE_LINE");

      const resInvalidProb = await POST(
        new Request("http://localhost:3000/api/bets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sportsbook: "FanDuel",
            decimalOdds: 2.5,
            stakeAmount: 50,
            legs: [sampleLeg],
            closingFairProb: 1.0,
          }),
        }),
      );
      expect(resInvalidProb.status).toBe(400);
      const bodyInvalidProb = await resInvalidProb.json();
      expect(bodyInvalidProb.error.code).toBe("INVALID_CLV");

      const resInvalidClv = await POST(
        new Request("http://localhost:3000/api/bets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sportsbook: "FanDuel",
            decimalOdds: 2.5,
            stakeAmount: 50,
            legs: [sampleLeg],
            clvPercentage: -1000,
          }),
        }),
      );
      expect(resInvalidClv.status).toBe(400);
      const bodyInvalidClv = await resInvalidClv.json();
      expect(bodyInvalidClv.error.code).toBe("INVALID_CLV");
    });

    it("PATCH /api/bets/[id] persists valid CLV fields on settlement and rejects >10% or invalid CLV", async () => {
      const fakeClient = new FakeRedisClient();
      const userId = sampleBet.userId;
      const pendingBet: TrackedBet = {
        ...sampleBet,
        betId: "patch-clv-bet",
        status: "pending",
      };
      fakeClient.store.set(userBetsKey(userId), JSON.stringify([pendingBet]));
      setRedisClientFactory(() => fakeClient);

      // Suspect outlier > 10.0%
      const resSuspect = await PATCH(
        new Request("http://localhost:3000/api/bets/patch-clv-bet", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            status: "won",
            clvPercentage: 12.5,
          }),
        }),
        { params: Promise.resolve({ id: "patch-clv-bet" }) },
      );
      expect(resSuspect.status).toBe(400);
      expect((await resSuspect.json()).error.code).toBe("SUSPECT_STALE_LINE");

      // Invalid closingDecimalOdds
      const resInvalid = await PATCH(
        new Request("http://localhost:3000/api/bets/patch-clv-bet", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            status: "won",
            closingDecimalOdds: 1.0,
          }),
        }),
        { params: Promise.resolve({ id: "patch-clv-bet" }) },
      );
      expect(resInvalid.status).toBe(400);
      expect((await resInvalid.json()).error.code).toBe("INVALID_CLV");

      // Valid settlement with CLV
      const resValid = await PATCH(
        new Request("http://localhost:3000/api/bets/patch-clv-bet", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            status: "won",
            closingDecimalOdds: 3.25,
            closingFairProb: 0.301,
            clvPercentage: 5.35,
          }),
        }),
        { params: Promise.resolve({ id: "patch-clv-bet" }) },
      );
      expect(resValid.status).toBe(200);
      const bodyValid = await resValid.json();
      expect(bodyValid.bet.status).toBe("won");
      expect(bodyValid.bet.closingDecimalOdds).toBe(3.25);
      expect(bodyValid.bet.closingFairProb).toBe(0.301);
      expect(bodyValid.bet.clvPercentage).toBe(5.35);
    });

    it("PATCH /api/bets/[id] preserves existing non-null CLV fields during settlement", async () => {
      const fakeClient = new FakeRedisClient();
      const userId = sampleBet.userId;
      const stampedPending: TrackedBet = {
        ...sampleBet,
        betId: "patch-preserve-clv",
        status: "pending",
        closingDecimalOdds: 3.1,
        closingFairProb: 0.305,
        clvPercentage: 6.75,
      };
      fakeClient.store.set(userBetsKey(userId), JSON.stringify([stampedPending]));
      setRedisClientFactory(() => fakeClient);

      const res = await PATCH(
        new Request("http://localhost:3000/api/bets/patch-preserve-clv", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            status: "lost",
            closingDecimalOdds: 2.0,
            closingFairProb: 0.5,
            clvPercentage: -2.0,
          }),
        }),
        { params: Promise.resolve({ id: "patch-preserve-clv" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bet.status).toBe("lost");
      expect(body.bet.closingDecimalOdds).toBe(3.1);
      expect(body.bet.closingFairProb).toBe(0.305);
      expect(body.bet.clvPercentage).toBe(6.75);
    });
  });
});


describe("Story 4.3 Review API Route Regression Tests", () => {
  function setupMockRedis(initialBets: TrackedBet[] = [], userId = "u-review") {
    const fakeRedis = new FakeRedisClient();
    if (initialBets.length > 0) {
      fakeRedis.store.set(userBetsKey(userId), JSON.stringify(initialBets));
    }
    setRedisClientFactory(() => fakeRedis);
    return fakeRedis;
  }

  const baseBody = {
    userId: "u-review",
    sportsbook: "fanduel",
    decimalOdds: 2.0,
    stakeAmount: 50,
    legs: [
      {
        propId: "p-rev-1",
        playerName: "Josh Allen",
        marketDisplay: "Pass Yards Over 265.5",
        line: 265.5,
        selection: "OVER",
        offeredDecimalOdds: 2.0,
      },
    ],
  };

  it("rejects JSON null, arrays, and primitives with 400 on POST /api/bets and PATCH /api/bets/[id]", async () => {
    setupMockRedis();

    for (const invalidPayload of [null, [], ["x"], "string", 42]) {
      const postRes = await POST(
        new Request("http://localhost/api/bets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invalidPayload),
        }),
      );
      expect(postRes.status).toBe(400);
      const postJson = await postRes.json();
      expect(postJson.error.code).toBe("INVALID_BODY");

      const patchRes = await PATCH(
        new Request("http://localhost/api/bets/b-missing", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invalidPayload),
        }),
        { params: Promise.resolve({ id: "b-missing" }) },
      );
      expect(patchRes.status).toBe(400);
      const patchJson = await patchRes.json();
      expect(patchJson.error.code).toBe("INVALID_BODY");
    }
  });

  it("supports snake_case CLV fields and strips CLV fields when POST status normalizes to staged", async () => {
    setupMockRedis();

    const snakeRes = await POST(
      new Request("http://localhost/api/bets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseBody,
          status: "WON",
          closing_decimal_odds: 1.9,
          closing_fair_prob: 0.52632,
          clv_percentage: 5.264,
        }),
      }),
    );
    expect(snakeRes.status).toBe(201);
    const snakeJson = await snakeRes.json();
    expect(snakeJson.bet.status).toBe("won");
    expect(snakeJson.bet.closingDecimalOdds).toBe(1.9);
    expect(snakeJson.bet.closingFairProb).toBe(0.52632);
    expect(snakeJson.bet.clvPercentage).toBe(5.264);

    const stagedRes = await POST(
      new Request("http://localhost/api/bets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseBody,
          status: "STAGED",
          closingDecimalOdds: 1.9,
          closingFairProb: 0.52,
          clvPercentage: 4.0,
        }),
      }),
    );
    expect(stagedRes.status).toBe(201);
    const stagedJson = await stagedRes.json();
    expect(stagedJson.bet.status).toBe("staged");
    expect(stagedJson.bet.closingDecimalOdds).toBeUndefined();
    expect(stagedJson.bet.closingFairProb).toBeUndefined();
    expect(stagedJson.bet.clvPercentage).toBeUndefined();
  });

  it("atomically preserves existing CLV snapshot on PATCH whenever any CLV field is non-null", async () => {
    const existingPartial: TrackedBet = {
      betId: "b-atomic-clv",
      userId: "u-review",
      sportsbook: "fanduel",
      decimalOdds: 2.0,
      americanOdds: 100,
      stakeAmount: 50,
      potentialPayout: 100,
      status: "pending",
      legs: baseBody.legs,
      quickpickUrl: "",
      placedAt: "2026-11-14T18:00:00Z",
      closingFairProb: 0.52,
    };
    setupMockRedis([existingPartial]);

    const patchRes = await PATCH(
      new Request("http://localhost/api/bets/b-atomic-clv", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "u-review",
          status: "WON",
          closingFairProb: 0.4,
          closingDecimalOdds: 2.5,
          clvPercentage: -5.0,
        }),
      }),
      { params: Promise.resolve({ id: "b-atomic-clv" }) },
    );
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.bet.status).toBe("won");
    expect(patchJson.bet.closingFairProb).toBe(0.52);
    expect(patchJson.bet.closingDecimalOdds).toBeUndefined();
    expect(patchJson.bet.clvPercentage).toBeUndefined();
  });

  it("rejects PATCH with ALREADY_SETTLED for uppercase WON and VOID statuses", async () => {
    const wonBet: TrackedBet = {
      betId: "b-upper-won",
      userId: "u-review",
      sportsbook: "fanduel",
      decimalOdds: 2.0,
      americanOdds: 100,
      stakeAmount: 50,
      potentialPayout: 100,
      status: "WON" as any,
      legs: baseBody.legs,
      quickpickUrl: "",
      placedAt: "2026-11-14T18:00:00Z",
    };
    const voidBet: TrackedBet = {
      ...wonBet,
      betId: "b-upper-void",
      status: "VOID" as any,
    };
    setupMockRedis([wonBet, voidBet]);

    for (const id of ["b-upper-won", "b-upper-void"]) {
      const res = await PATCH(
        new Request(`http://localhost/api/bets/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "u-review", status: "lost" }),
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("ALREADY_SETTLED");
    }
  });
});
