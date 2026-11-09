import type { PresetCard, PresetLeg } from "@/types/preset";

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

  // Recalculate hybrid value score
  const hitRates = updatedLegs
    .map((l) => (l.hitRateL10 ? parseFloat(l.hitRateL10) : 0.7))
    .filter((n) => !isNaN(n));
  const avgHitRate =
    hitRates.length > 0 ? hitRates.reduce((a, b) => a + b, 0) / hitRates.length : 0.7;
  const hitPct = avgHitRate * 100.0;
  const evComponent = Math.max(0.0, Math.min(100.0, combinedEv * 100.0 * 10.0 + 50.0));
  const newHybridScore = Math.max(0, Math.min(100, Math.round(0.6 * hitPct + 0.4 * evComponent)));

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
