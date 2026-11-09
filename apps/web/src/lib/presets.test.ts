import { describe, expect, it } from "vitest";
import {
  decimalToAmerican,
  FALLBACK_PRESET_FEED,
  recalculatePresetCard,
} from "./presets";

describe("presets lib unit tests", () => {
  it("converts decimal odds to American correctly", () => {
    expect(decimalToAmerican(2.0)).toBe(100);
    expect(decimalToAmerican(5.85)).toBe(485);
    expect(decimalToAmerican(1.75)).toBe(-133);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(() => decimalToAmerican(1.0)).toThrow();
  });

  it("recalculates card odds and EV when a constituent leg odds update", () => {
    const card = FALLBACK_PRESET_FEED.cards[0];
    const targetLeg = card.legs[0];

    // Update leg from 1.80 to 2.00
    const updatedCard = recalculatePresetCard(card, targetLeg.propId, 2.0);

    expect(updatedCard.legs[0].offeredDecimalOdds).toBe("2.0000");
    expect(updatedCard.legs[0].offeredAmericanOdds).toBe(100);
    // Combined odds should increase: 2.0 * 2.1 = 4.2000
    expect(parseFloat(updatedCard.combinedDecimalOdds)).toBeCloseTo(4.2, 2);
    expect(updatedCard.combinedAmericanOdds).toBe(320);
    expect(parseFloat(updatedCard.combinedEv)).toBeGreaterThan(parseFloat(card.combinedEv));
  });

  it("returns unchanged card when propId does not match any leg", () => {
    const card = FALLBACK_PRESET_FEED.cards[0];
    const updated = recalculatePresetCard(card, "non-existent-prop-id", 2.5);
    expect(updated).toBe(card);
  });

  it("ensures fallback preset feed meets all acceptance criteria", () => {
    expect(FALLBACK_PRESET_FEED.cards.length).toBeGreaterThanOrEqual(3);
    expect(FALLBACK_PRESET_FEED.cards.length).toBeLessThanOrEqual(5);

    for (const card of FALLBACK_PRESET_FEED.cards) {
      expect(card.legs.length).toBeGreaterThanOrEqual(2);
      expect(card.legs.length).toBeLessThanOrEqual(4);
      expect(card.title).toBeTruthy();
      expect(card.themeBadge).toBeTruthy();
      expect(card.hybridValueScore).toBeGreaterThanOrEqual(0);
      expect(card.hybridValueScore).toBeLessThanOrEqual(100);

      for (const leg of card.legs) {
        expect(leg.playerName).toBeTruthy();
        expect(leg.matchup).toBeTruthy();
        expect(leg.marketDisplay).toBeTruthy();
        expect(leg.hitRateDisplay).toBeTruthy();
        expect(leg.sofascoreDots).toBeTruthy();
        expect(leg.convictionRationale).toBeTruthy();
      }
    }
  });
});
