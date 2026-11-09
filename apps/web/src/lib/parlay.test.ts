import { describe, expect, it } from "vitest";
import type { MarketPropRow } from "@/types/market";
import type { ParlayLeg } from "@/types/parlay";
import {
  addLegToSlip,
  calculateParlaySlip,
  getEligibleSwapCandidates,
  marketPropRowToParlayLeg,
  presetLegToParlayLeg,
  removeLegFromSlip,
  swapLegInSlip,
  updateSlipLegOdds,
} from "./parlay";

function createMockLeg(overrides: Partial<ParlayLeg> = {}): ParlayLeg {
  return {
    propId: "prop_1",
    eventId: "event_1",
    sportKey: "nfl",
    playerName: "Lamar Jackson",
    teamAbbreviation: "BAL",
    matchup: "BAL @ KC",
    marketKey: "player_pass_yds",
    marketDisplay: "Over 224.5 Pass Yds",
    selection: "OVER",
    lineValue: 224.5,
    offeredDecimalOdds: "1.9091",
    offeredAmericanOdds: -110,
    fairProbability: "0.5500",
    guardedEv: "0.0500",
    hitRateL10: "0.80",
    hitRateDisplay: "8/10 L10",
    sofascoreForm: [true, true, true, false, true],
    ...overrides,
  };
}

function createMockPropRow(overrides: Partial<MarketPropRow> = {}): MarketPropRow {
  return {
    propId: "prop_m1",
    eventId: "event_m1",
    sportKey: "nfl",
    playerName: "Derrick Henry",
    teamAbbreviation: "BAL",
    matchup: "BAL @ KC",
    commenceTime: "2026-11-10T01:15:00Z",
    dateWindow: "today",
    marketKey: "player_rush_yds",
    marketLabel: "Rushing Yards",
    marketDisplay: "Over 78.5 Rush Yds",
    selection: "OVER",
    lineValue: 78.5,
    offeredDecimalOdds: "1.8696",
    offeredAmericanOdds: -115,
    fairProbability: "0.5600",
    guardedEv: "0.0469",
    hitRateL5: "0.80",
    hitRateL10: "0.80",
    hitRateSeason: "0.75",
    hitRateDisplay: "8/10 L10",
    sofascoreForm: [true, true, true, true, false],
    sofascoreDots: "●●●●○",
    hybridValueScore: 82,
    status: "ACTIVE",
    valueTier: "POSITIVE_VALUE",
    isHighValue: false,
    ...overrides,
  };
}

describe("parlay library - calculateParlaySlip", () => {
  it("calculates empty slip cleanly with isValidParlay = false", () => {
    const slip = calculateParlaySlip([]);
    expect(slip.legs.length).toBe(0);
    expect(slip.isValidParlay).toBe(false);
    expect(slip.combinedDecimalOdds).toBe("1.0000");
    expect(slip.combinedAmericanOdds).toBe(100);
    expect(slip.combinedEv).toBe("0.0000");
    expect(slip.hybridValueScore).toBe(0);
    expect(slip.isSameGameParlay).toBe(false);
  });

  it("marks single-leg ticket as isValidParlay = false (minimum 2 legs required)", () => {
    const leg1 = createMockLeg({
      offeredDecimalOdds: "2.0000",
      fairProbability: "0.5500",
      hitRateL10: "0.80",
    });
    const slip = calculateParlaySlip([leg1]);
    expect(slip.legs.length).toBe(1);
    expect(slip.isValidParlay).toBe(false);
    expect(slip.combinedDecimalOdds).toBe("2.0000");
    expect(slip.combinedAmericanOdds).toBe(100);
    expect(parseFloat(slip.combinedEv)).toBeCloseTo(0.10, 3);
  });

  it("calculates multi-leg parlay odds, EV, and clamped hybrid score for independent legs", () => {
    const leg1 = createMockLeg({
      propId: "prop_1",
      eventId: "event_1",
      offeredDecimalOdds: "2.0000",
      fairProbability: "0.5500",
      hitRateL10: "0.80",
    });
    const leg2 = createMockLeg({
      propId: "prop_2",
      eventId: "event_2",
      offeredDecimalOdds: "2.5000",
      fairProbability: "0.4500",
      hitRateL10: "0.70",
    });

    const slip = calculateParlaySlip([leg1, leg2]);

    expect(slip.isValidParlay).toBe(true);
    expect(slip.isSameGameParlay).toBe(false);

    // Combined Decimal Odds: 2.0 * 2.5 = 5.0
    expect(slip.combinedDecimalOdds).toBe("5.0000");
    // American Odds: (5.0 - 1.0) * 100 = +400
    expect(slip.combinedAmericanOdds).toBe(400);

    // Combined Fair Probability: 0.55 * 0.45 = 0.2475
    expect(parseFloat(slip.combinedFairProbability)).toBeCloseTo(0.2475, 4);

    // Combined EV: (0.2475 * 5.0) - 1.0 = 1.2375 - 1.0 = 0.2375 (+23.75%)
    expect(parseFloat(slip.combinedEv)).toBeCloseTo(0.2375, 4);

    // Hybrid score clamp verification:
    // avgHitRate = (0.80 + 0.70) / 2 = 0.75 -> hitPct = 75.0
    // evComponent = clamp(0, 100, 23.75 * 10 + 50) = clamp(0, 100, 287.5) = 100
    // score = clamp(0, 100, round(0.60 * 75.0 + 0.40 * 100)) = round(45 + 40) = 85
    expect(slip.hybridValueScore).toBe(85);
  });

  it("detects Same-Game Parlay (SGP) when 2 or more legs share the same eventId", () => {
    const leg1 = createMockLeg({ propId: "p1", eventId: "game_kc_bal" });
    const leg2 = createMockLeg({ propId: "p2", eventId: "game_kc_bal" });

    const slip = calculateParlaySlip([leg1, leg2]);
    expect(slip.isSameGameParlay).toBe(true);
  });
});

describe("parlay library - addLegToSlip", () => {
  it("appends leg to active slip and recalculates totals", () => {
    const initialSlip = calculateParlaySlip([
      createMockLeg({ propId: "p1", offeredDecimalOdds: "1.9091" }),
    ]);
    const leg2 = createMockLeg({ propId: "p2", offeredDecimalOdds: "2.0000" });

    const result = addLegToSlip(initialSlip, leg2);
    expect(result.error).toBeUndefined();
    expect(result.slip.legs.length).toBe(2);
    expect(result.slip.isValidParlay).toBe(true);
  });

  it("prevents duplicate selections of the exact same propId", () => {
    const leg1 = createMockLeg({ propId: "p1" });
    const initialSlip = calculateParlaySlip([leg1]);

    const result = addLegToSlip(initialSlip, leg1);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("already in slip");
    expect(result.slip.legs.length).toBe(1);
  });

  it("enforces maximum 8 legs per ticket boundary", () => {
    const legs: ParlayLeg[] = Array.from({ length: 8 }, (_, i) =>
      createMockLeg({ propId: `p_${i}`, offeredDecimalOdds: "1.9091" }),
    );
    const slip8 = calculateParlaySlip(legs);
    expect(slip8.legs.length).toBe(8);

    const leg9 = createMockLeg({ propId: "p_9" });
    const result = addLegToSlip(slip8, leg9);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("8 legs");
    expect(result.slip.legs.length).toBe(8);
  });
});

describe("parlay library - removeLegFromSlip", () => {
  it("removes specified leg and recalculates remaining legs immediately", () => {
    const leg1 = createMockLeg({ propId: "p1", offeredDecimalOdds: "2.0000" });
    const leg2 = createMockLeg({ propId: "p2", offeredDecimalOdds: "2.0000" });
    const leg3 = createMockLeg({ propId: "p3", offeredDecimalOdds: "2.0000" });

    const slip3 = calculateParlaySlip([leg1, leg2, leg3]);
    expect(slip3.legs.length).toBe(3);
    expect(parseFloat(slip3.combinedDecimalOdds)).toBeCloseTo(8.0, 3);

    const slip2 = removeLegFromSlip(slip3, "p2");
    expect(slip2.legs.length).toBe(2);
    expect(slip2.legs.map((l) => l.propId)).toEqual(["p1", "p3"]);
    expect(parseFloat(slip2.combinedDecimalOdds)).toBeCloseTo(4.0, 3);
  });

  it("sets isValidParlay to false when legs drop below 2", () => {
    const leg1 = createMockLeg({ propId: "p1" });
    const leg2 = createMockLeg({ propId: "p2" });

    const slip2 = calculateParlaySlip([leg1, leg2]);
    expect(slip2.isValidParlay).toBe(true);

    const slip1 = removeLegFromSlip(slip2, "p2");
    expect(slip1.legs.length).toBe(1);
    expect(slip1.isValidParlay).toBe(false);
  });
});

describe("parlay library - swapLegInSlip", () => {
  it("replaces target leg with replacement candidate and recalculates slip", () => {
    const leg1 = createMockLeg({ propId: "p1", offeredDecimalOdds: "2.0000" });
    const leg2 = createMockLeg({ propId: "p2", offeredDecimalOdds: "2.0000" });
    const replacement = createMockLeg({
      propId: "p_alt",
      offeredDecimalOdds: "3.0000",
      playerName: "Mark Andrews",
    });

    const slip = calculateParlaySlip([leg1, leg2]);
    const swappedSlip = swapLegInSlip(slip, "p2", replacement);

    expect(swappedSlip.legs.length).toBe(2);
    expect(swappedSlip.legs[1].propId).toBe("p_alt");
    expect(swappedSlip.legs[1].playerName).toBe("Mark Andrews");
    expect(parseFloat(swappedSlip.combinedDecimalOdds)).toBeCloseTo(6.0, 3);
  });

  it("returns unchanged slip if target leg is not found", () => {
    const leg1 = createMockLeg({ propId: "p1" });
    const slip = calculateParlaySlip([leg1]);
    const replacement = createMockLeg({ propId: "p_alt" });

    const result = swapLegInSlip(slip, "non_existent", replacement);
    expect(result.legs.length).toBe(1);
    expect(result.legs[0].propId).toBe("p1");
  });

  it("returns unchanged slip if replacement prop is already in another leg of slip", () => {
    const leg1 = createMockLeg({ propId: "p1" });
    const leg2 = createMockLeg({ propId: "p2" });
    const slip = calculateParlaySlip([leg1, leg2]);

    // Attempt to swap p2 with p1 (which already exists in the slip)
    const result = swapLegInSlip(slip, "p2", leg1);
    expect(result).toBe(slip);
  });
});

describe("parlay library - updateSlipLegOdds", () => {
  it("updates decimal and american odds in place and recalculates parlay totals", () => {
    const leg1 = createMockLeg({
      propId: "p1",
      offeredDecimalOdds: "2.0000",
      offeredAmericanOdds: 100,
      fairProbability: "0.5000",
    });
    const leg2 = createMockLeg({
      propId: "p2",
      offeredDecimalOdds: "2.0000",
      offeredAmericanOdds: 100,
      fairProbability: "0.5000",
    });

    const initialSlip = calculateParlaySlip([leg1, leg2]);
    expect(initialSlip.combinedDecimalOdds).toBe("4.0000");
    expect(initialSlip.combinedAmericanOdds).toBe(300);

    // Update leg2 odds to 2.50 (+150)
    const updatedSlip = updateSlipLegOdds(initialSlip, "p2", 2.5);

    expect(updatedSlip.legs[1].offeredDecimalOdds).toBe("2.5000");
    expect(updatedSlip.legs[1].offeredAmericanOdds).toBe(150);
    // Combined odds: 2.0 * 2.5 = 5.0 (+400)
    expect(updatedSlip.combinedDecimalOdds).toBe("5.0000");
    expect(updatedSlip.combinedAmericanOdds).toBe(400);
  });

  it("leaves slip unchanged if propId does not match any leg", () => {
    const leg1 = createMockLeg({ propId: "p1" });
    const slip = calculateParlaySlip([leg1]);

    const updated = updateSlipLegOdds(slip, "unknown_prop", 2.2);
    expect(updated).toBe(slip);
  });
});

describe("parlay library - getEligibleSwapCandidates", () => {
  it("filters candidates by matching sport and active slate/dateWindow, excluding target and active legs", () => {
    const targetLeg = createMockLeg({
      propId: "p_target",
      sportKey: "nfl",
      dateWindow: "today",
    });
    const otherLegInSlip = createMockLeg({
      propId: "p_existing",
      sportKey: "nfl",
      dateWindow: "today",
    });
    const currentSlipLegs = [targetLeg, otherLegInSlip];

    const candidatePool: MarketPropRow[] = [
      // Valid candidate 1
      createMockPropRow({
        propId: "cand_1",
        sportKey: "nfl",
        dateWindow: "today",
        hybridValueScore: 85,
        guardedEv: "0.05",
      }),
      // Valid candidate 2 (higher score)
      createMockPropRow({
        propId: "cand_2",
        sportKey: "nfl",
        dateWindow: "today",
        hybridValueScore: 92,
        guardedEv: "0.08",
      }),
      // Target leg itself (should be excluded)
      createMockPropRow({
        propId: "p_target",
        sportKey: "nfl",
        dateWindow: "today",
      }),
      // Other leg in slip (should be excluded)
      createMockPropRow({
        propId: "p_existing",
        sportKey: "nfl",
        dateWindow: "today",
      }),
      // Wrong sport (NBA instead of NFL)
      createMockPropRow({
        propId: "cand_nba",
        sportKey: "nba",
        dateWindow: "today",
      }),
      // Outlier / stale line: EV > 10.0% (guardedEv = "0.12")
      createMockPropRow({
        propId: "cand_stale",
        sportKey: "nfl",
        dateWindow: "today",
        guardedEv: "0.1200",
        hybridValueScore: 99,
      }),
    ];

    const candidates = getEligibleSwapCandidates(
      targetLeg,
      candidatePool,
      currentSlipLegs,
    );

    // Only cand_2 and cand_1 should be returned, sorted by hybridValueScore desc
    expect(candidates.map((c) => c.propId)).toEqual(["cand_2", "cand_1"]);
  });

  it("strictly excludes non-ACTIVE candidates (SUSPECT_STALE_LINE, SUSPENDED, SETTLED)", () => {
    const targetLeg = createMockLeg({ propId: "p_target", sportKey: "nfl" });
    const pool = [
      createMockPropRow({
        propId: "cand_active",
        status: "ACTIVE",
        hybridValueScore: 80,
      }),
      createMockPropRow({
        propId: "cand_stale_line",
        status: "SUSPECT_STALE_LINE" as any,
        hybridValueScore: 95,
      }),
      createMockPropRow({
        propId: "cand_suspended",
        status: "SUSPENDED" as any,
        hybridValueScore: 90,
      }),
      createMockPropRow({
        propId: "cand_settled",
        status: "SETTLED" as any,
        hybridValueScore: 85,
      }),
    ];

    const eligible = getEligibleSwapCandidates(targetLeg, pool, [targetLeg]);
    expect(eligible.map((c) => c.propId)).toEqual(["cand_active"]);
  });

  it("ranks candidates by hybridValueScore descending, then guardedEv descending for ties with NaN fallback", () => {
    const targetLeg = createMockLeg({ propId: "p_target", sportKey: "nba" });
    const pool: MarketPropRow[] = [
      createMockPropRow({
        propId: "c1",
        sportKey: "nba",
        hybridValueScore: 80,
        guardedEv: "0.03",
      }),
      createMockPropRow({
        propId: "c2",
        sportKey: "nba",
        hybridValueScore: 80,
        guardedEv: "0.07",
      }),
      createMockPropRow({
        propId: "c3",
        sportKey: "nba",
        hybridValueScore: 90,
        guardedEv: "0.02",
      }),
      createMockPropRow({
        propId: "c4_nan",
        sportKey: "nba",
        hybridValueScore: 80,
        guardedEv: "invalid_nan",
      }),
    ];

    const candidates = getEligibleSwapCandidates(targetLeg, pool, [targetLeg]);
    // c3 (90), then among 80s: c2 (0.07), c1 (0.03), c4_nan (0)
    expect(candidates.map((c) => c.propId)).toEqual(["c3", "c2", "c1", "c4_nan"]);
  });
});

describe("parlay library - converter utilities", () => {
  it("converts marketPropRow to ParlayLeg accurately", () => {
    const row = createMockPropRow({ propId: "m1", playerName: "Patrick Mahomes" });
    const leg = marketPropRowToParlayLeg(row);

    expect(leg.propId).toBe("m1");
    expect(leg.playerName).toBe("Patrick Mahomes");
    expect(leg.sportKey).toBe("nfl");
    expect(leg.offeredDecimalOdds).toBe(row.offeredDecimalOdds);
  });

  it("converts presetLeg to ParlayLeg accurately with optional dateWindow forwarded", () => {
    const presetLeg = {
      propId: "pl1",
      eventId: "e1",
      playerName: "Travis Kelce",
      teamAbbreviation: "KC",
      matchup: "BAL @ KC",
      marketKey: "player_pass_yds",
      marketDisplay: "Over 65.5 Rec Yds",
      selection: "OVER" as const,
      lineValue: 65.5,
      offeredDecimalOdds: "1.9091",
      offeredAmericanOdds: -110,
      fairProbability: "0.5500",
      guardedEv: "0.0500",
      hitRateL10: "0.80",
      hitRateDisplay: "8/10 L10",
      sofascoreForm: [true, true, true, false, true],
      sofascoreDots: "●●●○●",
      convictionRationale: "Prime target in dome conditions",
    };

    const leg = presetLegToParlayLeg(presetLeg, "nfl", "tomorrow");
    expect(leg.propId).toBe("pl1");
    expect(leg.sportKey).toBe("nfl");
    expect(leg.playerName).toBe("Travis Kelce");
    expect(leg.convictionRationale).toBe("Prime target in dome conditions");
    expect(leg.dateWindow).toBe("tomorrow");
  });
});
