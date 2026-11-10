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
});
