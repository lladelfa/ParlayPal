import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getStagedBets,
  saveStagedBet,
  clearStagedBets,
  getGuestUserId,
  stageBetLocally,
  getTrackedBets,
  saveTrackedBet,
  confirmStagedBet,
  updateTrackedBetStatus,
  deleteTrackedBet,
  calculateBetSummaryMetrics,
  resolveBetSportBucket,
  computeSimulatedClosingBenchmark,
  validateClvBenchmarkInput,
  STAGED_BETS_STORAGE_KEY,
  TRACKED_BETS_STORAGE_KEY,
  GUEST_USER_ID_STORAGE_KEY,
} from "./ledger";
import type { StagedBet, BetLeg, TrackedBet } from "@/types/bet";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("Client Staged Bet Ledger (apps/web/src/lib/ledger.ts)", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal("localStorage", mockStorage);
    vi.restoreAllMocks();
  });

  const mockLeg: BetLeg = {
    propId: "prop-123",
    playerName: "Patrick Mahomes",
    marketDisplay: "Pass Yds Over 274.5",
    line: 274.5,
    selection: "OVER",
    offeredDecimalOdds: "1.91",
  };

  const createMockBet = (id: string, overrrides?: Partial<StagedBet>): StagedBet => ({
    betId: id,
    userId: "guest-user-1",
    sportsbook: "fanduel",
    decimalOdds: 3.5,
    americanOdds: 250,
    stakeAmount: 50,
    potentialPayout: 175,
    status: "staged",
    legs: [mockLeg],
    quickpickUrl: "https://quickpick.pikkit.com/test",
    stagedAt: "2026-11-10T12:00:00.000Z",
    ...overrrides,
  });

  it("returns empty array when no staged bets are saved in localStorage", () => {
    const bets = getStagedBets();
    expect(bets).toEqual([]);
  });

  it("saves and retrieves a staged bet successfully", () => {
    const bet = createMockBet("bet-uuid-1");
    saveStagedBet(bet);

    const bets = getStagedBets();
    expect(bets).toHaveLength(1);
    expect(bets[0]).toEqual(bet);
  });

  it("prepends newer staged bets to the beginning of the ledger", () => {
    const bet1 = createMockBet("bet-uuid-1", { stagedAt: "2026-11-10T10:00:00.000Z" });
    const bet2 = createMockBet("bet-uuid-2", { stagedAt: "2026-11-10T11:00:00.000Z" });

    saveStagedBet(bet1);
    saveStagedBet(bet2);

    const bets = getStagedBets();
    expect(bets).toHaveLength(2);
    expect(bets[0].betId).toBe("bet-uuid-2");
    expect(bets[1].betId).toBe("bet-uuid-1");
  });

  it("deduplicates and updates a bet if a bet with the same betId is re-saved", () => {
    const betOriginal = createMockBet("bet-uuid-1", { stakeAmount: 25 });
    saveStagedBet(betOriginal);

    const betUpdated = createMockBet("bet-uuid-1", { stakeAmount: 50 });
    saveStagedBet(betUpdated);

    const bets = getStagedBets();
    expect(bets).toHaveLength(1);
    expect(bets[0].stakeAmount).toBe(50);
  });

  it("enforces maximum cap of 100 entries to prevent localStorage bloat", () => {
    for (let i = 1; i <= 105; i++) {
      saveStagedBet(createMockBet(`bet-${i}`, { stagedAt: `2026-11-10T10:${String(i % 60).padStart(2, "0")}:00.000Z` }));
    }

    const bets = getStagedBets();
    expect(bets).toHaveLength(100);
    // Most recently saved (bet-105) must be first
    expect(bets[0].betId).toBe("bet-105");
    // Oldest bets should have been dropped
    expect(bets.find((b) => b.betId === "bet-1")).toBeUndefined();
  });

  it("handles corrupt JSON in localStorage gracefully without throwing", () => {
    localStorage.setItem(STAGED_BETS_STORAGE_KEY, "{corrupt-invalid-json");

    const bets = getStagedBets();
    expect(bets).toEqual([]);
  });

  it("clears all staged bets via clearStagedBets", () => {
    saveStagedBet(createMockBet("bet-uuid-1"));
    expect(getStagedBets()).toHaveLength(1);

    clearStagedBets();
    expect(getStagedBets()).toEqual([]);
  });

  it("getGuestUserId generates and persists a valid UUID v4 string across invocations", () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const userId1 = getGuestUserId();
    expect(userId1).toMatch(uuidRegex);

    const userId2 = getGuestUserId();
    expect(userId2).toBe(userId1);
    expect(localStorage.getItem(GUEST_USER_ID_STORAGE_KEY)).toBe(userId1);
  });

  it("stageBetLocally builds a valid StagedBet with default UUIDs and status: 'staged'", () => {
    const result = stageBetLocally({
      sportsbook: "draftkings",
      legs: [mockLeg],
      decimalOdds: 2.1,
      americanOdds: 110,
      stakeAmount: 50,
      potentialPayout: 105,
      quickpickUrl: "https://quickpick.pikkit.com/staged",
    });

    expect(result.status).toBe("staged");
    expect(result.sportsbook).toBe("draftkings");
    expect(result.betId).toBeDefined();
    expect(result.userId).toBeDefined();
    expect(result.stagedAt).toBeDefined();

    const stored = getStagedBets();
    expect(stored).toHaveLength(1);
    expect(stored[0].betId).toBe(result.betId);
  });

  it("stageBetLocally throws an error if decimal odds are < 1.01", () => {
    expect(() =>
      stageBetLocally({
        sportsbook: "fanduel",
        legs: [mockLeg],
        decimalOdds: 1.005,
      }),
    ).toThrowError("Invalid decimal odds: 1.005. Must be >= 1.01.");
  });

  it("stageBetLocally throws an error if a leg has EV > 10.0% or status === SUSPECT_STALE_LINE", () => {
    const staleLeg: BetLeg = {
      ...mockLeg,
      guardedEv: 0.12,
    };
    expect(() =>
      stageBetLocally({
        sportsbook: "fanduel",
        legs: [staleLeg],
        decimalOdds: 2.0,
      }),
    ).toThrowError(/Cannot stage suspect stale line/);

    const staleStatusLeg: BetLeg = {
      ...mockLeg,
      guardedEv: 0.05,
      status: "SUSPECT_STALE_LINE",
    } as any;
    expect(() =>
      stageBetLocally({
        sportsbook: "fanduel",
        legs: [staleStatusLeg],
        decimalOdds: 2.0,
      }),
    ).toThrowError(/Cannot stage suspect stale line/);
  });

  it("handles SSR / absence of window and localStorage gracefully", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("window", undefined);

    expect(getStagedBets()).toEqual([]);
    const guestId = getGuestUserId();
    expect(guestId).toBeDefined();

    const bet = createMockBet("ssr-bet");
    expect(saveStagedBet(bet)).toEqual(bet);
    expect(() => clearStagedBets()).not.toThrow();
  });

  describe("Tracked Bet Ledger Operations & Metrics", () => {
    it("getTrackedBets returns staged and tracked bets sorted by recency", () => {
      const staged = createMockBet("staged-1", { stagedAt: "2026-11-10T10:00:00Z" });
      saveStagedBet(staged);

      const tracked = {
        ...createMockBet("tracked-1"),
        status: "pending" as const,
        placedAt: "2026-11-10T11:00:00Z",
      };
      saveTrackedBet(tracked);

      const all = getTrackedBets();
      expect(all).toHaveLength(2);
      expect(all[0].betId).toBe("tracked-1");
      expect(all[1].betId).toBe("staged-1");
    });

    it("confirmStagedBet transitions bet from staged to pending with confirmed stake", () => {
      const staged = createMockBet("bet-confirm", {
        decimalOdds: 3.0,
        stakeAmount: 10,
        potentialPayout: 30,
      });
      saveStagedBet(staged);

      const confirmed = confirmStagedBet("bet-confirm", 25.0);
      expect(confirmed.status).toBe("pending");
      expect(confirmed.stakeAmount).toBe(25.0);
      expect(confirmed.potentialPayout).toBe(75.0);
      expect(confirmed.placedAt).toBeDefined();

      const retrieved = getTrackedBets().find((b) => b.betId === "bet-confirm");
      expect(retrieved?.status).toBe("pending");
      expect(retrieved?.stakeAmount).toBe(25.0);
    });

    it("confirmStagedBet throws if stake is <= 0 or invalid", () => {
      const staged = createMockBet("bet-invalid-stake");
      saveStagedBet(staged);

      expect(() => confirmStagedBet("bet-invalid-stake", 0)).toThrowError(
        "Stake must be greater than $0.00",
      );
      expect(() => confirmStagedBet("bet-invalid-stake", -50)).toThrowError(
        "Stake must be greater than $0.00",
      );
      expect(() => confirmStagedBet("bet-invalid-stake", NaN)).toThrowError(
        "Stake must be greater than $0.00",
      );
    });

    it("confirmStagedBet throws if bet is not found", () => {
      expect(() => confirmStagedBet("non-existent-id", 50)).toThrowError(
        "Bet with id non-existent-id not found.",
      );
    });

    it("updateTrackedBetStatus updates status, stamps settledAt, and prevents re-settling finalized bets", () => {
      const pendingBet: TrackedBet = {
        ...createMockBet("bet-settle"),
        status: "pending",
        placedAt: "2026-11-10T12:00:00Z",
      };
      saveTrackedBet(pendingBet);

      const won = updateTrackedBetStatus("bet-settle", "won");
      expect(won.status).toBe("won");
      expect(won.settledAt).toBeDefined();

      // Trying to re-settle a finalized won bet throws
      expect(() => updateTrackedBetStatus("bet-settle", "lost")).toThrowError(
        /Cannot re-settle an already finalized bet/,
      );
    });

    it("deleteTrackedBet removes the bet from all storage keys", () => {
      const staged = createMockBet("bet-delete-me");
      saveStagedBet(staged);

      expect(getTrackedBets().some((b) => b.betId === "bet-delete-me")).toBe(true);

      const removed = deleteTrackedBet("bet-delete-me");
      expect(removed).toBe(true);
      expect(getTrackedBets().some((b) => b.betId === "bet-delete-me")).toBe(false);
      expect(getStagedBets().some((b) => b.betId === "bet-delete-me")).toBe(false);
    });

    it("calculateBetSummaryMetrics accurately calculates totals, active action, net profit, and ROI", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("b1"),
          status: "staged",
          stakeAmount: 50,
          decimalOdds: 2.0,
          potentialPayout: 100,
        },
        {
          ...createMockBet("b2"),
          status: "pending",
          stakeAmount: 25,
          decimalOdds: 3.0,
          potentialPayout: 75,
        },
        {
          ...createMockBet("b3"),
          status: "won",
          stakeAmount: 50,
          decimalOdds: 2.5,
          potentialPayout: 125, // returns $125
        },
        {
          ...createMockBet("b4"),
          status: "lost",
          stakeAmount: 50,
          decimalOdds: 2.0,
          potentialPayout: 100,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.totalBets).toBe(4);
      expect(metrics.stagedCount).toBe(1);
      expect(metrics.pendingCount).toBe(1);
      expect(metrics.wonCount).toBe(1);
      expect(metrics.lostCount).toBe(1);
      expect(metrics.activeAction).toBe(25);
      // Total staked (pending + won + lost) = 25 + 50 + 50 = 125
      expect(metrics.totalStaked).toBe(125);
      // Total settled staked = 50 (won) + 50 (lost) = 100
      expect(metrics.totalSettledStaked).toBe(100);
      // Total return = 125
      expect(metrics.totalReturn).toBe(125);
      // Net profit = 125 - 100 = 25
      expect(metrics.netProfit).toBe(25);
      // ROI = (25 / 100) * 100 = 25%
      expect(metrics.roi).toBe(25);
    });
  });

  describe("CLV Analytics, Bucketing & Deterministic Settlement Simulation", () => {
    it("computes beat rate and stake-weighted average CLV% across mixed pending and settled bets", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("clv-1", { sportsbook: "FanDuel" }),
          status: "pending",
          stakeAmount: 50,
          clvPercentage: 4.0,
          closingFairProb: 0.29714,
          closingDecimalOdds: 3.37,
        },
        {
          ...createMockBet("clv-2", { sportsbook: "DraftKings" }),
          status: "won",
          stakeAmount: 25,
          clvPercentage: 2.0,
          closingFairProb: 0.29143,
          closingDecimalOdds: 3.43,
        },
        {
          ...createMockBet("clv-3", { sportsbook: "BetMGM" }),
          status: "lost",
          stakeAmount: 25,
          clvPercentage: -3.0,
          closingFairProb: 0.27714,
          closingDecimalOdds: 3.61,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.clvTrackedCount).toBe(3);
      expect(metrics.clvBeatCount).toBe(2);
      expect(metrics.closingLineBeatRate).toBe(66.67);
      // (4.0*50 + 2.0*25 + (-3.0)*25) / (50 + 25 + 25) = 175 / 100 = 1.75
      expect(metrics.averageClvPercentage).toBe(1.75);
      // (4.0 + 2.0 - 3.0) / 3 = 1.0
      expect(metrics.unweightedAverageClvPercentage).toBe(1);
    });

    it("returns zero CLV metrics without NaN when only staged or unstamped bets exist", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("staged-with-clv"),
          status: "staged",
          clvPercentage: 5.0,
          stakeAmount: 50,
        },
        {
          ...createMockBet("pending-unstamped"),
          status: "pending",
          clvPercentage: null,
          stakeAmount: 25,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.clvTrackedCount).toBe(0);
      expect(metrics.clvBeatCount).toBe(0);
      expect(metrics.closingLineBeatRate).toBe(0);
      expect(metrics.averageClvPercentage).toBe(0);
      expect(metrics.unweightedAverageClvPercentage).toBe(0);
      expect(metrics.bySport).toEqual([]);
      expect(metrics.bySportsbook).toEqual([]);
      expect(Number.isNaN(metrics.closingLineBeatRate)).toBe(false);
      expect(Number.isNaN(metrics.averageClvPercentage)).toBe(false);
    });

    it("falls back to unweighted average CLV% when total eligible stake is 0", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("zero-stake-1"),
          status: "settled_won",
          stakeAmount: 0,
          clvPercentage: 4.0,
        },
        {
          ...createMockBet("zero-stake-2"),
          status: "push",
          stakeAmount: 0,
          clvPercentage: -1.0,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.clvTrackedCount).toBe(2);
      expect(metrics.clvBeatCount).toBe(1);
      expect(metrics.closingLineBeatRate).toBe(50);
      expect(metrics.unweightedAverageClvPercentage).toBe(1.5);
      expect(metrics.averageClvPercentage).toBe(1.5);
    });

    it("treats exact 0.000% CLV as tracked but not beating closing line", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("zero-clv"),
          status: "void",
          stakeAmount: 50,
          clvPercentage: 0,
        },
        {
          ...createMockBet("pos-clv"),
          status: "settled_lost",
          stakeAmount: 50,
          clvPercentage: 4.0,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.clvTrackedCount).toBe(2);
      expect(metrics.clvBeatCount).toBe(1);
      expect(metrics.closingLineBeatRate).toBe(50);
      expect(metrics.averageClvPercentage).toBe(2);
    });

    it("enforces positive-only +10.0% outlier circuit breaker and excludes non-finite/out-of-range CLV", () => {
      const bets: TrackedBet[] = [
        {
          ...createMockBet("suspect-clv"),
          status: "won",
          stakeAmount: 100,
          clvPercentage: 12.5,
        },
        {
          ...createMockBet("just-above-cap"),
          status: "pending",
          stakeAmount: 50,
          clvPercentage: 10.001,
        },
        {
          ...createMockBet("too-negative"),
          status: "lost",
          stakeAmount: 50,
          clvPercentage: -1000,
        },
        {
          ...createMockBet("nan-clv"),
          status: "pending",
          stakeAmount: 50,
          clvPercentage: Number.NaN,
        },
        {
          ...createMockBet("boundary-valid"),
          status: "won",
          stakeAmount: 50,
          clvPercentage: 10.0,
        },
        {
          ...createMockBet("large-negative-valid"),
          status: "lost",
          stakeAmount: 50,
          clvPercentage: -20.0,
        },
      ];

      const metrics = calculateBetSummaryMetrics(bets);
      expect(metrics.clvTrackedCount).toBe(2);
      expect(metrics.clvBeatCount).toBe(1);
      expect(metrics.closingLineBeatRate).toBe(50);
      expect(metrics.averageClvPercentage).toBe(-5);
    });

    it("resolves NFL, NBA, Multi-Sport, and Other buckets and aggregates bySport and bySportsbook", () => {
      const nflBet: TrackedBet = {
        ...createMockBet("bet-nfl", {
          sportsbook: "fanduel",
          legs: [
            {
              ...mockLeg,
              sportKey: "americanfootball_nfl",
              marketKey: "player_pass_yds",
            },
          ],
        }),
        status: "won",
        stakeAmount: 50,
        clvPercentage: 4.0,
      };
      const nbaBet: TrackedBet = {
        ...createMockBet("bet-nba", {
          sportsbook: "FanDuel",
          legs: [
            {
              propId: "nba-1",
              playerName: "Nikola Jokic",
              marketDisplay: "Points Over 26.5",
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              sportKey: "basketball_nba",
              marketKey: "player_points",
            },
          ],
        }),
        status: "pending",
        stakeAmount: 50,
        clvPercentage: -2.0,
      };
      const multiBet: TrackedBet = {
        ...createMockBet("bet-multi", {
          sportsbook: "DraftKings",
          legs: [
            {
              ...mockLeg,
              sportKey: "nfl",
              marketKey: "player_anytime_td",
            },
            {
              propId: "nba-2",
              playerName: "Stephen Curry",
              marketDisplay: "Threes Over 4.5",
              selection: "OVER",
              offeredDecimalOdds: 2.05,
              sportKey: "nba",
              marketKey: "player_threes",
            },
          ],
        }),
        status: "won",
        stakeAmount: 100,
        clvPercentage: 3.2,
      };
      const otherBet: TrackedBet = {
        ...createMockBet("bet-other", {
          sportsbook: "BetMGM",
          legs: [
            {
              propId: "custom-1",
              playerName: "Unknown Athlete",
              marketDisplay: "Custom Special",
              selection: "OVER",
              offeredDecimalOdds: 2.0,
              marketKey: "custom_exotic",
            },
          ],
        }),
        status: "lost",
        stakeAmount: 50,
        clvPercentage: 1.0,
      };

      expect(resolveBetSportBucket(nflBet)).toBe("NFL");
      expect(resolveBetSportBucket(nbaBet)).toBe("NBA");
      expect(resolveBetSportBucket(multiBet)).toBe("Multi-Sport");
      expect(resolveBetSportBucket(otherBet)).toBe("Other");

      const metrics = calculateBetSummaryMetrics([nflBet, nbaBet, multiBet, otherBet]);
      expect(metrics.bySport.map((b) => b.label)).toEqual([
        "NFL",
        "NBA",
        "Multi-Sport",
        "Other",
      ]);

      const multiBucket = metrics.bySport.find((b) => b.label === "Multi-Sport");
      expect(multiBucket).toBeDefined();
      expect(multiBucket?.trackedCount).toBe(1);
      expect(multiBucket?.beatCount).toBe(1);
      expect(multiBucket?.beatRate).toBe(100);
      expect(multiBucket?.averageClvPercentage).toBe(3.2);

      // fanduel + FanDuel normalize under FanDuel
      const fdBucket = metrics.bySportsbook.find((b) => b.label === "FanDuel");
      expect(fdBucket).toBeDefined();
      expect(fdBucket?.trackedCount).toBe(2);
      expect(fdBucket?.beatCount).toBe(1);
      expect(fdBucket?.beatRate).toBe(50);
      expect(fdBucket?.averageClvPercentage).toBe(1);

      const dkBucket = metrics.bySportsbook.find((b) => b.label === "DraftKings");
      expect(dkBucket).toBeDefined();
      expect(dkBucket?.trackedCount).toBe(1);
      expect(dkBucket?.averageClvPercentage).toBe(3.2);
    });

    it("updateTrackedBetStatus deterministically stamps CLV benchmarks on unstamped pending bet", () => {
      const pendingBet: TrackedBet = {
        ...createMockBet("bet-sim-clv", {
          decimalOdds: 2.5,
          legs: [
            {
              ...mockLeg,
              guardedEv: 0.042,
            },
          ],
        }),
        status: "pending",
        placedAt: "2026-11-10T12:00:00Z",
      };
      saveTrackedBet(pendingBet);

      const expectedSim = computeSimulatedClosingBenchmark(pendingBet);
      expect(expectedSim.closingFairProb).toBeGreaterThan(0);
      expect(expectedSim.closingFairProb).toBeLessThan(1);
      expect(expectedSim.closingDecimalOdds).toBeGreaterThanOrEqual(1.01);
      expect(expectedSim.clvPercentage).toBeGreaterThanOrEqual(-3.5);
      expect(expectedSim.clvPercentage).toBeLessThanOrEqual(5.5);
      // Determinism check
      expect(computeSimulatedClosingBenchmark(pendingBet)).toEqual(expectedSim);

      const settled = updateTrackedBetStatus("bet-sim-clv", "won");
      expect(settled.status).toBe("won");
      expect(settled.clvPercentage).toBe(expectedSim.clvPercentage);
      expect(settled.closingFairProb).toBe(expectedSim.closingFairProb);
      expect(settled.closingDecimalOdds).toBe(expectedSim.closingDecimalOdds);
    });

    it("updateTrackedBetStatus never overwrites existing non-null CLV fields on settlement", () => {
      const preStamped: TrackedBet = {
        ...createMockBet("bet-already-clv", { decimalOdds: 2.5 }),
        status: "pending",
        placedAt: "2026-11-10T12:00:00Z",
        clvPercentage: 6.25,
        closingFairProb: 0.425,
        closingDecimalOdds: 2.35,
      };
      saveTrackedBet(preStamped);

      const settled = updateTrackedBetStatus("bet-already-clv", "lost");
      expect(settled.status).toBe("lost");
      expect(settled.clvPercentage).toBe(6.25);
      expect(settled.closingFairProb).toBe(0.425);
      expect(settled.closingDecimalOdds).toBe(2.35);
    });

    it("computeSimulatedClosingBenchmark falls back to deterministic hash within [-3.5%, +5.5%] without guardedEv and resolveBetSportBucket infers from marketKey", () => {
      const noEvBet: TrackedBet = {
        ...createMockBet("bet-no-ev-hash", {
          decimalOdds: 2.2,
          legs: [
            {
              propId: "p-no-ev",
              playerName: "Ja'Marr Chase",
              marketDisplay: "Receptions Over 6.5",
              selection: "OVER",
              offeredDecimalOdds: 2.2,
              marketKey: "player_receptions",
            },
          ],
        }),
        status: "pending",
      };

      expect(resolveBetSportBucket(noEvBet)).toBe("NFL");

      const sim1 = computeSimulatedClosingBenchmark(noEvBet);
      const sim2 = computeSimulatedClosingBenchmark(noEvBet);
      expect(sim1).toEqual(sim2);
      expect(sim1.clvPercentage).toBeGreaterThanOrEqual(-3.5);
      expect(sim1.clvPercentage).toBeLessThanOrEqual(5.5);
      expect(sim1.closingFairProb).toBeGreaterThan(0);
      expect(sim1.closingFairProb).toBeLessThan(1);
      expect(sim1.closingDecimalOdds).toBeGreaterThanOrEqual(1.01);
      expect(sim1.closingDecimalOdds).toBeLessThanOrEqual(9999.9999);
    });
  });
});


describe("Story 4.3 Review Edge-Case & Regression Suite", () => {
  class ReviewMockStorage implements Storage {
    private store = new Map<string, string>();
    get length() {
      return this.store.size;
    }
    clear(): void {
      this.store.clear();
    }
    getItem(key: string): string | null {
      return this.store.get(key) ?? null;
    }
    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null;
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
  }

  let storage: ReviewMockStorage;

  beforeEach(() => {
    storage = new ReviewMockStorage();
    vi.stubGlobal("localStorage", storage);
  });

  function makeBet(overrides: Partial<TrackedBet> = {}): TrackedBet {
    return {
      betId: "b0000000-0000-4000-8000-000000000999",
      userId: "guest-review",
      sportsbook: "fanduel",
      decimalOdds: 1.91,
      americanOdds: -110,
      stakeAmount: 100,
      potentialPayout: 191,
      status: "won",
      legs: [
        {
          propId: "prop-review-1",
          playerName: "Josh Allen",
          marketDisplay: "Pass Yards Over 265.5",
          line: 265.5,
          selection: "OVER",
          offeredDecimalOdds: 1.91,
        },
      ],
      quickpickUrl: "https://fanduel.com",
      placedAt: "2026-11-14T18:00:00Z",
      ...overrides,
    };
  }

  it("validateClvBenchmarkInput enforces +10.0% inclusive boundary and rejects +10.001%", () => {
    const exactLimit = validateClvBenchmarkInput({
      closingDecimalOdds: 1.82,
      closingFairProb: 0.55,
      clvPercentage: 10.0,
    });
    expect(exactLimit.ok).toBe(true);
    if (exactLimit.ok) {
      expect(exactLimit.clvPercentage).toBe(10);
      expect(exactLimit.closingDecimalOdds).toBe(1.82);
      expect(exactLimit.closingFairProb).toBe(0.55);
    }

    const overLimit = validateClvBenchmarkInput({
      closingDecimalOdds: 1.82,
      closingFairProb: 0.55,
      clvPercentage: 10.001,
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.status).toBe(400);
      expect(overLimit.code).toBe("SUSPECT_STALE_LINE");
    }

    const lowOdds = validateClvBenchmarkInput({ closingDecimalOdds: 1.0 });
    expect(lowOdds.ok).toBe(false);
    const badProb = validateClvBenchmarkInput({ closingFairProb: 1.0 });
    expect(badProb.ok).toBe(false);
  });

  it("classifies wnba as Other, nfl_nba and NFL+MLB parlays as Multi-Sport, and NFL props including Kicking Points", () => {
    expect(
      resolveBetSportBucket(
        makeBet({
          legs: [
            {
              propId: "wnba-1",
              sportKey: "basketball_wnba",
              playerName: "A'ja Wilson",
              marketDisplay: "Points Over 24.5",
              line: 24.5,
              selection: "OVER",
              offeredDecimalOdds: 1.9,
            },
          ],
        }),
      ),
    ).toBe("Other");

    expect(
      resolveBetSportBucket(
        makeBet({
          legs: [
            {
              propId: "conflicting-1",
              sportKey: "nfl_nba",
              playerName: "Cross Sport",
              marketDisplay: "Combo",
              line: 1.5,
              selection: "OVER",
              offeredDecimalOdds: 2.0,
            },
          ],
        }),
      ),
    ).toBe("Multi-Sport");

    expect(
      resolveBetSportBucket(
        makeBet({
          legs: [
            {
              propId: "fallback-1",
              sportKey: "",
              marketKey: "",
              playerName: "Lamar Jackson",
              marketDisplay: "Pass Yards Over 245.5",
              line: 245.5,
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              ...({ sport_key: "americanfootball_nfl" } as any),
            },
          ],
        }),
      ),
    ).toBe("NFL");

    expect(
      resolveBetSportBucket(
        makeBet({
          legs: [
            {
              propId: "nfl-leg",
              sportKey: "nfl",
              playerName: "Bijan Robinson",
              marketDisplay: "Rush Yards Over 75.5",
              line: 75.5,
              selection: "OVER",
              offeredDecimalOdds: 1.91,
            },
            {
              propId: "mlb-leg",
              sportKey: "baseball_mlb",
              playerName: "Shohei Ohtani",
              marketDisplay: "Total Bases Over 1.5",
              line: 1.5,
              selection: "OVER",
              offeredDecimalOdds: 1.95,
            },
          ],
        }),
      ),
    ).toBe("Multi-Sport");

    for (const display of [
      "Kicking Points Over 7.5",
      "Anytime Touchdowns",
      "Pass Yards Over 250.5",
      "Rush Yards Over 60.5",
      "Receiving Yards Over 80.5",
      "Interceptions Over 0.5",
      "Turnovers Under 0.5",
    ]) {
      expect(
        resolveBetSportBucket(
          makeBet({
            legs: [
              {
                propId: `nfl-${display}`,
                playerName: "NFL Player",
                marketDisplay: display,
                line: 1.5,
                selection: "OVER",
                offeredDecimalOdds: 1.91,
              },
            ],
          }),
        ),
      ).toBe("NFL");
    }

    expect(
      resolveBetSportBucket(makeBet({ legs: "not-an-array" as any })),
    ).toBe("Other");
  });

  it("normalizes sportsbook aliases deterministically and handles prototype keys like constructor", () => {
    const metrics = calculateBetSummaryMetrics([
      makeBet({
        betId: "b-1",
        sportsbook: "dk",
        clvPercentage: 2.0,
        stakeAmount: 50,
      }),
      makeBet({
        betId: "b-2",
        sportsbook: "Draft Kings Sportsbook",
        clvPercentage: 4.0,
        stakeAmount: 50,
      }),
      makeBet({
        betId: "b-3",
        sportsbook: "Caesars Sportsbook",
        clvPercentage: 1.5,
        stakeAmount: 100,
      }),
      makeBet({
        betId: "b-4",
        sportsbook: "caesars",
        clvPercentage: 2.5,
        stakeAmount: 100,
      }),
      makeBet({
        betId: "b-5",
        sportsbook: "constructor",
        clvPercentage: 3.0,
        stakeAmount: 25,
      }),
    ]);

    const dkBucket = metrics.bySportsbook.find((b) => b.key === "draftkings");
    expect(dkBucket).toBeDefined();
    expect(dkBucket?.label).toBe("DraftKings");
    expect(dkBucket?.trackedCount).toBe(2);

    const caesarsBucket = metrics.bySportsbook.find((b) => b.key === "caesars");
    expect(caesarsBucket).toBeDefined();
    expect(caesarsBucket?.label).toBe("Caesars");
    expect(caesarsBucket?.trackedCount).toBe(2);

    const constructorBucket = metrics.bySportsbook.find(
      (b) => b.key === "constructor",
    );
    expect(constructorBucket).toBeDefined();
    expect(constructorBucket?.label).toBe("Constructor");
    expect(constructorBucket?.trackedCount).toBe(1);
  });

  it("skips simulated CLV stamping when transitioning out of staged and respects partial closingFairProb", () => {
    const stagedBet = makeBet({
      betId: "staged-transition",
      status: "staged",
      closingDecimalOdds: undefined,
      closingFairProb: undefined,
      clvPercentage: undefined,
    });
    saveTrackedBet(stagedBet);

    const settledFromStaged = updateTrackedBetStatus("staged-transition", "won");
    expect(settledFromStaged.status).toBe("won");
    expect(settledFromStaged.closingDecimalOdds).toBeUndefined();
    expect(settledFromStaged.closingFairProb).toBeUndefined();
    expect(settledFromStaged.clvPercentage).toBeUndefined();

    const partialClvBet = makeBet({
      betId: "partial-clv-keep",
      status: "pending",
      closingFairProb: 0.54,
      closingDecimalOdds: undefined,
      clvPercentage: undefined,
    });
    saveTrackedBet(partialClvBet);

    const settledPartial = updateTrackedBetStatus("partial-clv-keep", "won");
    expect(settledPartial.closingFairProb).toBe(0.54);
    expect(settledPartial.closingDecimalOdds).toBeUndefined();
    expect(settledPartial.clvPercentage).toBeUndefined();

    const nanClvBet = makeBet({
      betId: "nan-clv-simulate",
      status: "pending",
      clvPercentage: Number.NaN,
      closingFairProb: "" as any,
    });
    saveTrackedBet(nanClvBet);

    const settledNan = updateTrackedBetStatus("nan-clv-simulate", "won");
    expect(typeof settledNan.clvPercentage).toBe("number");
    expect(Number.isFinite(settledNan.clvPercentage)).toBe(true);
    expect(settledNan.clvPercentage!).toBeLessThanOrEqual(10.0);
  });

  it("computeSimulatedClosingBenchmark handles NaN decimalOdds, non-array legs, and high odds >= 9173 without exceeding +10.0% CLV", () => {
    const fallbackBench = computeSimulatedClosingBenchmark(
      makeBet({
        betId: "nan-odds",
        decimalOdds: Number.NaN,
        combinedDecimalOdds: 2.5,
        legs: "corrupt" as any,
      }),
    );
    expect(Number.isFinite(fallbackBench.closingDecimalOdds)).toBe(true);
    expect(fallbackBench.closingFairProb).toBeGreaterThan(0);
    expect(fallbackBench.closingFairProb).toBeLessThan(1);
    expect(fallbackBench.clvPercentage).toBeLessThanOrEqual(10.0);

    for (const highOdds of [9173, 9500, 9999.9999]) {
      const highBench = computeSimulatedClosingBenchmark(
        makeBet({
          betId: `high-odds-${highOdds}`,
          decimalOdds: highOdds,
          legs: [
            {
              propId: "high-ev-leg",
              playerName: "Longshot",
              marketDisplay: "Anytime Touchdown",
              line: 0.5,
              selection: "OVER",
              offeredDecimalOdds: highOdds,
              guardedEv: 0.08,
            },
          ],
        }),
      );
      expect(highBench.closingFairProb).toBeGreaterThan(0);
      expect(highBench.closingFairProb).toBeLessThan(1);
      expect(highBench.closingFairProb * highOdds - 1).toBeLessThanOrEqual(0.1);
      expect(highBench.clvPercentage).toBeLessThanOrEqual(10.0);
    }
  });

  it("guards 1e308 stake overflow and falls back from NaN stakeAmount to stake", () => {
    const overflowMetrics = calculateBetSummaryMetrics([
      makeBet({ betId: "ov-1", stakeAmount: 1e308, clvPercentage: 2.0 }),
      makeBet({ betId: "ov-2", stakeAmount: 1e308, clvPercentage: 4.0 }),
    ]);
    expect(Number.isFinite(overflowMetrics.averageClvPercentage)).toBe(true);
    expect(overflowMetrics.averageClvPercentage).toBe(3);

    const nanStakeMetrics = calculateBetSummaryMetrics([
      makeBet({
        betId: "ns-1",
        stakeAmount: Number.NaN,
        stake: 80,
        clvPercentage: 4.0,
      }),
      makeBet({
        betId: "ns-2",
        stakeAmount: 20,
        clvPercentage: -1.0,
      }),
    ]);
    expect(nanStakeMetrics.totalStaked).toBe(100);
    // Weighted avg: (4 * 80 + -1 * 20) / 100 = 300 / 100 = 3.0
    expect(nanStakeMetrics.averageClvPercentage).toBe(3);
  });
});
