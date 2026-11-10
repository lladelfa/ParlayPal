import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { TrackedBet } from "@/types/bet";
import { BetTrackerDashboard } from "./BetTrackerDashboard";
import { saveTrackedBet, clearStagedBets } from "@/lib/ledger";

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

describe("BetTrackerDashboard (apps/web/src/components/BetTrackerDashboard.tsx)", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal("localStorage", mockStorage);
  });

  const mockBets: TrackedBet[] = [
    {
      betId: "bet-staged-1",
      userId: "user-1",
      sportsbook: "DraftKings",
      decimalOdds: 3.5,
      americanOdds: 250,
      stakeAmount: 50,
      potentialPayout: 175,
      status: "staged",
      legs: [
        {
          propId: "p1",
          playerName: "Patrick Mahomes",
          marketDisplay: "Pass Yds Over 274.5",
          selection: "OVER",
          offeredDecimalOdds: 1.91,
          teamAbbreviation: "KC",
        },
      ],
      stagedAt: "2026-11-10T10:00:00.000Z",
    },
    {
      betId: "bet-pending-1",
      userId: "user-1",
      sportsbook: "FanDuel",
      decimalOdds: 2.8,
      americanOdds: 180,
      stakeAmount: 25,
      potentialPayout: 70,
      status: "pending",
      legs: [
        {
          propId: "p2",
          playerName: "Lamar Jackson",
          marketDisplay: "Rush Yds Over 54.5",
          selection: "OVER",
          offeredDecimalOdds: 1.87,
          teamAbbreviation: "BAL",
          liveProgress: {
            status: "in_progress",
            period: "Q3 4:12",
            scoreDisplay: "BAL 21, PIT 14",
          },
        },
      ],
      placedAt: "2026-11-10T11:00:00.000Z",
      liveProgress: {
        status: "in_progress",
        period: "Q3 4:12",
        scoreDisplay: "BAL 21, PIT 14",
      },
    },
    {
      betId: "bet-won-1",
      userId: "user-1",
      sportsbook: "BetMGM",
      decimalOdds: 2.5,
      americanOdds: 150,
      stakeAmount: 50,
      potentialPayout: 125,
      status: "won",
      legs: [
        {
          propId: "p3",
          playerName: "Travis Kelce",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          offeredDecimalOdds: 2.5,
          teamAbbreviation: "KC",
        },
      ],
      placedAt: "2026-11-10T09:00:00.000Z",
      settledAt: "2026-11-10T13:00:00.000Z",
    },
  ];

  it("renders empty state with CTA button when no bets are present", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={[]} onNavigate={() => {}} />,
    );

    expect(markup).toContain("No tracked bets yet");
    expect(markup).toContain("Explore Curated Presets");
  });

  it("renders metric summary cards correctly", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    // Total Bets = 3
    expect(markup).toContain("Total Bets");
    expect(markup).toContain("3");

    // Active Action = $25.00
    expect(markup).toContain("Active Action");
    expect(markup).toContain("$25.00");

    // Staged Slips = 1
    expect(markup).toContain("Staged Slips");
    expect(markup).toContain("1");

    // Net P/L = 125 (return) - 50 (settled stake) = +$75.00
    expect(markup).toContain("+$75.00");

    // ROI = (75 / 50) * 100 = +150.0%
    expect(markup).toContain("+150.0%");
  });

  it("renders all status filter tabs with respective counts", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("All (3)");
    expect(markup).toContain("Staged (1)");
    expect(markup).toContain("Pending / Live (1)");
    expect(markup).toContain("Won (1)");
    expect(markup).toContain("Lost (0)");
  });

  it("renders ticket cards with sportsbooks, odds, and leg details", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    // Sportsbooks
    expect(markup).toContain("DraftKings");
    expect(markup).toContain("FanDuel");
    expect(markup).toContain("BetMGM");

    // American odds
    expect(markup).toContain("+250");
    expect(markup).toContain("+180");
    expect(markup).toContain("+150");

    // Player legs
    expect(markup).toContain("Patrick Mahomes");
    expect(markup).toContain("Pass Yds Over 274.5");
    expect(markup).toContain("Lamar Jackson");
    expect(markup).toContain("Rush Yds Over 54.5");
    expect(markup).toContain("Travis Kelce");
    expect(markup).toContain("Anytime Touchdown");

    // Live score progress pill
    expect(markup).toContain("Q3 4:12 · BAL 21, PIT 14");

    // Potential payouts
    expect(markup).toContain("$175.00");
    expect(markup).toContain("$70.00");
    expect(markup).toContain("$125.00");
  });

  it("renders Staged Slip controls (Confirm Placed, Discard, stake input) on staged ticket", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("Staged Slip");
    expect(markup).toContain("Confirm Placed");
    expect(markup).toContain("Discard");
    expect(markup).toContain('aria-label="Stake amount"');
  });

  it("renders simulate settlement buttons for pending bets", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("Pending / Live");
    expect(markup).toContain("Simulate Settle:");
    expect(markup).toContain("Won");
    expect(markup).toContain("Lost");
  });

  it("loads persisted bets from localStorage when mounted without initialBets", () => {
    saveTrackedBet(mockBets[0]);
    saveTrackedBet(mockBets[1]);

    const markup = renderToStaticMarkup(<BetTrackerDashboard />);
    expect(markup).toContain("DraftKings");
    expect(markup).toContain("FanDuel");
  });
});
