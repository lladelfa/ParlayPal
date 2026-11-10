import { describe, expect, it } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import type { SportsbookId } from "@/types/lineshopper";
import {
  calculateBookmakerPayout,
  calculateDollarEdge,
  compareMultiBookOdds,
  DEFAULT_REFERENCE_STAKE,
} from "./lineshopper";

function createMockLeg(
  propId: string,
  playerName: string,
  marketDisplay: string,
  quotes?: Partial<Record<SportsbookId, { decimalOdds: number; isAvailable?: boolean }>>,
): ParlayLeg {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey: "player_anytime_td",
    marketDisplay,
    selection: "OVER",
    lineValue: 0.5,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    fairProbability: "0.50000",
    guardedEv: "0.0200",
    sportsbookQuotes: quotes
      ? (Object.fromEntries(
          Object.entries(quotes).map(([k, v]) => [
            k,
            {
              sportsbook: k as SportsbookId,
              sportsbookId: k as SportsbookId,
              decimalOdds: v.decimalOdds,
              isAvailable: v.isAvailable ?? true,
            },
          ]),
        ) as ParlayLeg["sportsbookQuotes"])
      : undefined,
  };
}

describe("Lineshopper Pricing Engine", () => {
  describe("Happy Path Multi-Book Comparison", () => {
    it("prices 2-leg parlay across all 4 books and highlights FanDuel as Best Value Book", () => {
      // Leg 1: Henry TD
      // Leg 2: St. Brown O6.5 Rec
      // FanDuel: 2.08 * 2.50 = 5.20 (+420)
      // DraftKings: 2.00 * 2.35 = 4.70 (+370)
      // BetMGM: 2.00 * 2.45 = 4.90 (+390)
      // Caesars: 2.00 * 2.25 = 4.50 (+350)
      const leg1 = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown", {
        fanduel: { decimalOdds: 2.08 },
        draftkings: { decimalOdds: 2.00 },
        betmgm: { decimalOdds: 2.00 },
        caesars: { decimalOdds: 2.00 },
      });

      const leg2 = createMockLeg("leg-2", "Amon-Ra St. Brown", "Over 6.5 Receptions", {
        fanduel: { decimalOdds: 2.50 },
        draftkings: { decimalOdds: 2.35 },
        betmgm: { decimalOdds: 2.45 },
        caesars: { decimalOdds: 2.25 },
      });

      const result = compareMultiBookOdds([leg1, leg2]);

      expect(result.hasComparison).toBe(true);
      expect(result.totalLegs).toBe(2);
      expect(result.bestValueBookId).toBe("fanduel");
      expect(result.bookmakers.fanduel.isBestValue).toBe(true);

      // Check combined decimal odds and American odds
      expect(result.bookmakers.fanduel.combinedDecimalOdds).toBeCloseTo(5.20, 2);
      expect(result.bookmakers.fanduel.combinedAmericanOdds).toBe(420);
      expect(result.bookmakers.fanduel.formattedAmericanOdds).toBe("+420");

      expect(result.bookmakers.draftkings.combinedDecimalOdds).toBeCloseTo(4.70, 2);
      expect(result.bookmakers.draftkings.combinedAmericanOdds).toBe(370);
      expect(result.bookmakers.draftkings.formattedAmericanOdds).toBe("+370");

      expect(result.bookmakers.betmgm.combinedDecimalOdds).toBeCloseTo(4.90, 2);
      expect(result.bookmakers.betmgm.combinedAmericanOdds).toBe(390);

      expect(result.bookmakers.caesars.combinedDecimalOdds).toBeCloseTo(4.50, 2);
      expect(result.bookmakers.caesars.combinedAmericanOdds).toBe(350);

      // Runner up is BetMGM (4.90) or DK depending on benchmark
      expect(result.runnerUpBookId).toBe("betmgm");
      // Dollar edge against runner up: (5.20 - 4.90) * 50 = $15
      expect(result.dollarEdge).toBeCloseTo(15.0, 1);

      // If compared specifically against DK benchmark: (5.20 - 4.70) * 50 = $25
      const edgeVsDk = calculateDollarEdge(5.20, 4.70, 50);
      expect(edgeVsDk).toBe(25);
    });

    it("calculates reference stake payouts correctly ($50 stake)", () => {
      const payout = calculateBookmakerPayout([2.0, 2.5]);
      expect(payout.combinedDecimalOdds).toBe(5.0);
      expect(payout.combinedAmericanOdds).toBe(400);

      const edge = calculateDollarEdge(5.0, 4.5, DEFAULT_REFERENCE_STAKE);
      expect(edge).toBe(25); // (5.0 - 4.5) * 50 = 25
    });

    it("returns 1.01 when calculateBookmakerPayout receives an empty quotes array", () => {
      const payout = calculateBookmakerPayout([]);
      expect(payout.combinedDecimalOdds).toBe(1.01);
      expect(payout.isAvailable).toBe(true);
    });
  });

  describe("Single Book Partial Leg Absence", () => {
    it("flags Caesars as unavailable when Leg 3 is missing, disqualifying it from Best Value", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 2.0 },
      });
      const leg2 = createMockLeg("leg-2", "Lamar Jackson", "Over 1.5 Passing TDs", {
        fanduel: { decimalOdds: 1.8 },
        draftkings: { decimalOdds: 1.8 },
        betmgm: { decimalOdds: 1.8 },
        caesars: { decimalOdds: 1.8 },
      });
      const leg3 = createMockLeg("leg-3", "Zay Flowers", "Over 54.5 Receiving Yards", {
        fanduel: { decimalOdds: 1.9 },
        draftkings: { decimalOdds: 1.9 },
        betmgm: { decimalOdds: 1.9 },
        caesars: { decimalOdds: 0, isAvailable: false }, // Caesars missing line
      });

      const result = compareMultiBookOdds([leg1, leg2, leg3]);

      expect(result.hasComparison).toBe(true);
      expect(result.bookmakers.caesars.isAvailable).toBe(false);
      expect(result.bookmakers.caesars.missingLegCount).toBe(1);
      expect(result.bookmakers.caesars.isBestValue).toBe(false);

      expect(result.bookmakers.fanduel.isAvailable).toBe(true);
      expect(result.bookmakers.draftkings.isAvailable).toBe(true);
      expect(result.bookmakers.betmgm.isAvailable).toBe(true);
      expect(result.hasMissingLines).toBe(true);
    });

    it("treats omitted bookmaker keys as unavailable when sportsbookQuotes is defined on leg", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        // caesars omitted completely
      });
      const leg2 = createMockLeg("leg-2", "Lamar Jackson", "Over 1.5 Passing TDs", {
        fanduel: { decimalOdds: 1.8 },
        draftkings: { decimalOdds: 1.8 },
        betmgm: { decimalOdds: 1.8 },
        caesars: { decimalOdds: 1.8 },
      });

      const result = compareMultiBookOdds([leg1, leg2]);
      expect(result.bookmakers.caesars.isAvailable).toBe(false);
      expect(result.bookmakers.caesars.missingLegCount).toBe(1);
    });
  });

  describe("Identical Top Odds Tiebreaker", () => {
    it("deterministically chooses FanDuel when FanDuel and DraftKings have identical top odds", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown", {
        fanduel: { decimalOdds: 2.5 },
        draftkings: { decimalOdds: 2.5 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 2.0 },
      });
      const leg2 = createMockLeg("leg-2", "Lamar Jackson", "Over 1.5 Passing TDs", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 2.0 },
      });

      const result = compareMultiBookOdds([leg1, leg2]);

      // Both FD and DK have combined decimal odds of 5.00 (+400)
      expect(result.bookmakers.fanduel.combinedDecimalOdds).toBe(5.0);
      expect(result.bookmakers.draftkings.combinedDecimalOdds).toBe(5.0);

      // FanDuel is first in integrated order
      expect(result.bestValueBookId).toBe("fanduel");
      expect(result.bookmakers.fanduel.isBestValue).toBe(true);
      expect(result.bookmakers.draftkings.isBestValue).toBe(false);

      // Edge indicates tie
      expect(result.dollarEdge).toBe(0);
      expect(result.edgeDescription).toContain("Even with DK");
    });
  });

  describe("1-Leg Slip State", () => {
    it("handles 1-leg slip as single-market comparison mode without designating a Best Value winner", () => {
      const singleLeg = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown", {
        fanduel: { decimalOdds: 1.95 },
        draftkings: { decimalOdds: 1.90 },
        betmgm: { decimalOdds: 1.85 },
        caesars: { decimalOdds: 1.80 },
      });

      const result = compareMultiBookOdds([singleLeg]);

      expect(result.hasComparison).toBe(true);
      expect(result.totalLegs).toBe(1);
      // Per spec boundary: 1-leg slips do NOT designate Best Value winner
      expect(result.bestValueBookId).toBeNull();
      expect(result.bookmakers.fanduel.isBestValue).toBe(false);
      expect(result.bookmakers.draftkings.isBestValue).toBe(false);
      expect(result.bookmakers.fanduel.combinedDecimalOdds).toBe(1.95);
      expect(result.bookmakers.draftkings.combinedDecimalOdds).toBe(1.90);
    });
  });

  describe("Empty Slip State", () => {
    it("returns clean empty comparison when 0 legs are present without crashing", () => {
      const result = compareMultiBookOdds([]);

      expect(result.hasComparison).toBe(false);
      expect(result.totalLegs).toBe(0);
      expect(result.bestValueBookId).toBeNull();
      expect(result.dollarEdge).toBe(0);
      expect(result.edgeDescription).toBe("");
    });
  });

  describe("Fallback Deterministic Quote Generation", () => {
    it("generates deterministic quotes across 4 books when legs have no explicit sportsbookQuotes", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown");
      const leg2 = createMockLeg("leg-2", "Lamar Jackson", "Over 1.5 Passing TDs");

      const result = compareMultiBookOdds([leg1, leg2]);

      expect(result.hasComparison).toBe(true);
      expect(result.bestValueBookId).not.toBeNull();
      expect(result.bookmakers.fanduel.combinedDecimalOdds).toBeGreaterThanOrEqual(1.01);
      expect(result.bookmakers.draftkings.combinedDecimalOdds).toBeGreaterThanOrEqual(1.01);
      expect(result.bookmakers.betmgm.combinedDecimalOdds).toBeGreaterThanOrEqual(1.01);
      expect(result.bookmakers.caesars.combinedDecimalOdds).toBeGreaterThanOrEqual(1.01);
    });
  });

  describe("User Selection Tracking", () => {
    it("flags the chosen bookmaker as isSelected when selectedSportsbook option is provided", () => {
      const leg = createMockLeg("leg-1", "Derrick Henry", "Anytime Touchdown");
      const result = compareMultiBookOdds([leg], { selectedSportsbook: "betmgm" });

      expect(result.bookmakers.betmgm.isSelected).toBe(true);
      expect(result.bookmakers.fanduel.isSelected).toBe(false);
    });
  });
});
