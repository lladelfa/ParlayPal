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
});
