import type { PresetCard, PresetLeg } from "@/types/preset";

/**
 * Hybrid Value Score: 0.6 * avg L10 hit rate % + 0.4 * EV component.
 * Only legs with a real L10 hit rate contribute; when none have one the score
 * is the EV component alone (no invented default hit rate).
 */
export function computeHybridValueScore(
  legs: ReadonlyArray<{ hitRateL10?: string | null }>,
  combinedEv: number,
): number {
  const hitRates = legs
    .map((l) =>
      l.hitRateL10 === null || l.hitRateL10 === undefined || l.hitRateL10 === ""
        ? NaN
        : Number(l.hitRateL10),
    )
    .filter((n) => Number.isFinite(n));
  const evComponent = Math.max(0.0, Math.min(100.0, combinedEv * 100.0 * 10.0 + 50.0));
  if (hitRates.length === 0) {
    return Math.max(0, Math.min(100, Math.round(evComponent)));
  }
  const avgHitRate = hitRates.reduce((a, b) => a + b, 0) / hitRates.length;
  return Math.max(
    0,
    Math.min(100, Math.round(0.6 * avgHitRate * 100.0 + 0.4 * evComponent)),
  );
}

export function decimalToAmerican(decimalOdds: number): number {
  if (decimalOdds < 1.01) {
    throw new Error(`Decimal odds must be >= 1.01, got ${decimalOdds}`);
  }
  if (decimalOdds >= 2.0) {
    return Math.round((decimalOdds - 1.0) * 100);
  }
  return Math.round(-100 / (decimalOdds - 1.0));
}

export function recalculatePresetCard(
  card: PresetCard,
  updatedPropId: string,
  newDecimalOdds: number,
): PresetCard {
  let matched = false;
  const updatedLegs: PresetLeg[] = card.legs.map((leg) => {
    if (leg.propId === updatedPropId) {
      matched = true;
      const decOddsStr = newDecimalOdds.toFixed(4);
      const amerOdds = decimalToAmerican(newDecimalOdds);
      return {
        ...leg,
        offeredDecimalOdds: decOddsStr,
        offeredAmericanOdds: amerOdds,
      };
    }
    return leg;
  });

  if (!matched) {
    return card;
  }

  // Joint math: D_combined = product(D_i), P_combined = product(P_i)
  let combinedDecimal = 1.0;
  let combinedFairProb = 1.0;

  for (const leg of updatedLegs) {
    combinedDecimal *= parseFloat(leg.offeredDecimalOdds);
    combinedFairProb *= parseFloat(leg.fairProbability);
  }

  const combinedEv = combinedFairProb * combinedDecimal - 1.0;
  const combinedAmericanOdds = decimalToAmerican(combinedDecimal);

  // Recalculate hybrid value score (real hit rates only)
  const newHybridScore = computeHybridValueScore(updatedLegs, combinedEv);

  return {
    ...card,
    legs: updatedLegs,
    combinedDecimalOdds: combinedDecimal.toFixed(4),
    combinedAmericanOdds,
    combinedFairProbability: combinedFairProb.toFixed(5),
    combinedEv: combinedEv.toFixed(4),
    hybridValueScore: newHybridScore,
  };
}
