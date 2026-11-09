import type { DateWindow, MarketPropRow } from "@/types/market";
import type { ParlayLeg, ParlaySlip } from "@/types/parlay";
import type { PresetLeg } from "@/types/preset";
import { decimalToAmerican } from "./math";

export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 8;
export const MAX_GUARDED_EV_THRESHOLD = 0.10;

/**
 * Classifies date window from an ISO timestamp.
 */
export function classifyDateWindow(commenceTimeIso: string): DateWindow {
  const eventDate = new Date(commenceTimeIso);
  const now = new Date();

  const eventDay = new Date(
    Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth(), eventDate.getUTCDate()),
  );
  const todayDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const diffDays = Math.round(
    (eventDay.getTime() - todayDay.getTime()) / (24 * 3600 * 1000),
  );

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "tomorrow";
  return "weekend";
}

/**
 * Pure calculation function for parlay tickets.
 * Recalculates combined odds, joint fair probability, guarded EV,
 * and composite Hybrid Value Score.
 */
export function calculateParlaySlip(legs: ParlayLeg[]): ParlaySlip {
  if (legs.length === 0) {
    return {
      legs: [],
      combinedDecimalOdds: "1.0000",
      combinedAmericanOdds: 100,
      combinedFairProbability: "1.00000",
      combinedEv: "0.0000",
      hybridValueScore: 0,
      isValidParlay: false,
      isSameGameParlay: false,
    };
  }

  // Joint decimal odds product: D_combined = prod(D_i)
  let combinedDecimal = 1.0;
  // Joint fair probability product: P_combined = prod(P_i)
  let combinedFairProb = 1.0;

  for (const leg of legs) {
    const dec = parseFloat(leg.offeredDecimalOdds) || 1.0;
    const fair = parseFloat(leg.fairProbability) || 0.5;
    combinedDecimal *= dec;
    combinedFairProb *= fair;
  }

  const combinedEv = combinedFairProb * combinedDecimal - 1.0;
  const combinedAmericanOdds = decimalToAmerican(Math.max(1.01, combinedDecimal));

  // Compute composite Hybrid Value Score
  const hitRates = legs
    .map((l) => (l.hitRateL10 ? parseFloat(l.hitRateL10) : 0.70))
    .filter((n) => !isNaN(n));
  const avgHitRate =
    hitRates.length > 0 ? hitRates.reduce((a, b) => a + b, 0) / hitRates.length : 0.70;
  const hitPct = avgHitRate * 100.0;
  const evPct = combinedEv * 100.0;
  const evComponent = Math.max(0.0, Math.min(100.0, evPct * 10.0 + 50.0));
  const hybridValueScore = Math.max(
    0,
    Math.min(100, Math.round(0.60 * hitPct + 0.40 * evComponent)),
  );

  // Check if at least 2 legs share the same eventId (Same Game Parlay)
  const eventIds = new Set(legs.map((l) => l.eventId));
  const isSameGameParlay = legs.length >= 2 && eventIds.size < legs.length;

  return {
    legs,
    combinedDecimalOdds: combinedDecimal.toFixed(4),
    combinedAmericanOdds,
    combinedFairProbability: combinedFairProb.toFixed(5),
    combinedEv: combinedEv.toFixed(4),
    hybridValueScore,
    isValidParlay: legs.length >= MIN_PARLAY_LEGS,
    isSameGameParlay,
  };
}

/**
 * Appends a leg to the active slip.
 * Rejects duplicate propId and enforces the MAX_PARLAY_LEGS (8) boundary.
 */
export function addLegToSlip(
  slip: ParlaySlip,
  newLeg: ParlayLeg,
): { slip: ParlaySlip; error?: string } {
  if (slip.legs.length >= MAX_PARLAY_LEGS) {
    return {
      slip,
      error: `Maximum ${MAX_PARLAY_LEGS} legs per ticket allowed.`,
    };
  }

  if (slip.legs.some((l) => l.propId === newLeg.propId)) {
    return {
      slip,
      error: "Prop is already in slip.",
    };
  }

  const updatedLegs = [...slip.legs, newLeg];
  return {
    slip: calculateParlaySlip(updatedLegs),
  };
}

/**
 * Removes a leg from the active slip and recalculates totals immediately.
 */
export function removeLegFromSlip(slip: ParlaySlip, propId: string): ParlaySlip {
  const updatedLegs = slip.legs.filter((l) => l.propId !== propId);
  return calculateParlaySlip(updatedLegs);
}

/**
 * Swaps a targeted leg in the slip with a candidate replacement.
 * Enforces duplicate prop prevention.
 */
export function swapLegInSlip(
  slip: ParlaySlip,
  targetPropId: string,
  replacementLeg: ParlayLeg,
): ParlaySlip {
  const targetIndex = slip.legs.findIndex((l) => l.propId === targetPropId);
  if (targetIndex === -1) {
    return slip;
  }

  // Prevent duplicate if replacement is already in slip at another position
  const alreadyInSlip = slip.legs.some(
    (l, idx) => idx !== targetIndex && l.propId === replacementLeg.propId,
  );
  if (alreadyInSlip) {
    return slip;
  }

  const updatedLegs = [...slip.legs];
  updatedLegs[targetIndex] = replacementLeg;
  return calculateParlaySlip(updatedLegs);
}

/**
 * Pure function to update the odds of a specific leg in the slip.
 * Updates both offeredDecimalOdds and offeredAmericanOdds, and recalculates totals.
 */
export function updateSlipLegOdds(
  slip: ParlaySlip,
  propId: string,
  newOdds: number,
): ParlaySlip {
  const exists = slip.legs.some((l) => l.propId === propId);
  if (!exists) {
    return slip;
  }

  const updatedLegs = slip.legs.map((leg) => {
    if (leg.propId === propId) {
      return {
        ...leg,
        offeredDecimalOdds: newOdds.toFixed(4),
        offeredAmericanOdds: decimalToAmerican(newOdds),
      };
    }
    return leg;
  });

  return calculateParlaySlip(updatedLegs);
}

/**
 * Filters and ranks candidate replacement props for the Leg Swapper modal.
 *
 * Invariants enforced:
 * - Match sportKey and slate (dateWindow) if present on targetLeg.
 * - Strictly exclude target leg itself.
 * - Strictly exclude any legs already selected in the active slip.
 * - Strictly exclude lines with guarded EV > 10.0% (SUSPECT_STALE_LINE circuit breaker).
 * - Exclude non-ACTIVE markets (must be status === "ACTIVE").
 * - Rank by hybridValueScore descending, then guardedEv descending (with NaN fallback).
 */
export function getEligibleSwapCandidates(
  targetLeg: ParlayLeg,
  candidatePool: MarketPropRow[],
  currentSlipLegs: ParlayLeg[],
): MarketPropRow[] {
  const currentSlipPropIds = new Set(currentSlipLegs.map((l) => l.propId));

  const eligible = candidatePool.filter((candidate) => {
    // Sport match
    if (candidate.sportKey !== targetLeg.sportKey) {
      return false;
    }

    // Slate match if target leg has dateWindow
    if (targetLeg.dateWindow && candidate.dateWindow !== targetLeg.dateWindow) {
      return false;
    }

    // Exclude target leg itself
    if (candidate.propId === targetLeg.propId) {
      return false;
    }

    // Exclude any leg already in slip
    if (currentSlipPropIds.has(candidate.propId)) {
      return false;
    }

    // Exclude stale or outlier lines (> 10.0% EV)
    const evVal = parseFloat(candidate.guardedEv);
    if (!isNaN(evVal) && evVal > MAX_GUARDED_EV_THRESHOLD) {
      return false;
    }

    // Must be ACTIVE (exclude SUSPECT_STALE_LINE, SUSPENDED, SETTLED, etc.)
    if (candidate.status !== "ACTIVE") {
      return false;
    }

    return true;
  });

  return eligible.sort((a, b) => {
    if (b.hybridValueScore !== a.hybridValueScore) {
      return b.hybridValueScore - a.hybridValueScore;
    }
    return (parseFloat(b.guardedEv) || 0) - (parseFloat(a.guardedEv) || 0);
  });
}

/**
 * Converts a MarketPropRow item from the market browser to a ParlayLeg.
 */
export function marketPropRowToParlayLeg(row: MarketPropRow): ParlayLeg {
  return {
    propId: row.propId,
    eventId: row.eventId,
    sportKey: row.sportKey,
    playerName: row.playerName,
    teamAbbreviation: row.teamAbbreviation,
    matchup: row.matchup,
    marketKey: row.marketKey,
    marketDisplay: row.marketDisplay,
    selection: row.selection,
    lineValue: row.lineValue,
    offeredDecimalOdds: row.offeredDecimalOdds,
    offeredAmericanOdds: row.offeredAmericanOdds,
    sharpDecimalOdds: row.sharpDecimalOdds,
    sharpAmericanOdds: row.sharpAmericanOdds,
    fairProbability: row.fairProbability,
    guardedEv: row.guardedEv,
    hitRateL5: row.hitRateL5,
    hitRateL10: row.hitRateL10,
    hitRateSeason: row.hitRateSeason,
    hitRateDisplay: row.hitRateDisplay,
    sofascoreForm: row.sofascoreForm,
    sofascoreDots: row.sofascoreDots,
    weatherBadge: row.weatherBadge,
    hybridValueScore: row.hybridValueScore,
    dateWindow: row.dateWindow,
    valueTier: row.valueTier,
    isHighValue: row.isHighValue,
  };
}

/**
 * Converts a PresetLeg item from a curated preset card to a ParlayLeg.
 * Accepts optional dateWindow and forwards it.
 */
export function presetLegToParlayLeg(
  leg: PresetLeg,
  sportKey: "nfl" | "nba",
  dateWindow?: DateWindow,
): ParlayLeg {
  return {
    propId: leg.propId,
    eventId: leg.eventId,
    sportKey,
    playerName: leg.playerName,
    teamAbbreviation: leg.teamAbbreviation,
    matchup: leg.matchup,
    marketKey: leg.marketKey,
    marketDisplay: leg.marketDisplay,
    selection: leg.selection,
    lineValue: leg.lineValue,
    offeredDecimalOdds: leg.offeredDecimalOdds,
    offeredAmericanOdds: leg.offeredAmericanOdds,
    sharpDecimalOdds: leg.sharpDecimalOdds,
    sharpAmericanOdds: leg.sharpAmericanOdds,
    fairProbability: leg.fairProbability,
    guardedEv: leg.guardedEv,
    hitRateL5: leg.hitRateL5,
    hitRateL10: leg.hitRateL10,
    hitRateSeason: leg.hitRateSeason,
    hitRateDisplay: leg.hitRateDisplay,
    sofascoreForm: leg.sofascoreForm,
    sofascoreDots: leg.sofascoreDots,
    weatherBadge: leg.weatherBadge,
    convictionRationale: leg.convictionRationale,
    dateWindow,
  };
}
