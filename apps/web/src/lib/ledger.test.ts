import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getStagedBets,
  saveStagedBet,
  clearStagedBets,
  getGuestUserId,
  stageBetLocally,
  STAGED_BETS_STORAGE_KEY,
  GUEST_USER_ID_STORAGE_KEY,
} from "./ledger";
import type { StagedBet, BetLeg } from "@/types/bet";

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
});
