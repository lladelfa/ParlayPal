import { describe, expect, it } from "vitest";
import {
  decimalToAmerican,
  FALLBACK_PRESET_FEED,
  normalizeCuratedPresetFeed,
  recalculatePresetCard,
} from "./presets";
import { computeHybridValueScore } from "./math";
import { PresetCard } from "@/components/PresetCard";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
        // Fixtures must not claim live-looking consistency data.
        expect(leg.hitRateDisplay).toBeNull();
        expect(leg.hitRateL10).toBeNull();
        expect(leg.sofascoreForm).toEqual([]);
        expect(leg.sofascoreDots).toBe("");
        expect(leg.convictionRationale).not.toMatch(/\d+ of last \d+|\/10/);
        expect(leg.convictionRationale).toBeTruthy();
      }
    }
  });

  describe("null hit-rate handling", () => {
    it("recalculatePresetCard scores EV-only when no leg has hitRateL10", () => {
      const card = FALLBACK_PRESET_FEED.cards[0];
      const updated = recalculatePresetCard(card, card.legs[0].propId, 2.0);
      const ev = parseFloat(updated.combinedEv);
      const expected = Math.max(0, Math.min(100, Math.round(ev * 1000 + 50)));
      expect(updated.hybridValueScore).toBe(expected);
    });

    const baseLeg = {
      propId: "p1",
      eventId: "e1",
      playerName: "Test Player",
      matchup: "A @ B",
      marketKey: "player_points",
      marketDisplay: "Over 20.5 Points",
      conviction_rationale: "r",
    };
    const feedWith = (legOverrides: Record<string, unknown>) => ({
      generatedAt: "2026-11-15T19:36:42Z",
      cards: [
        {
          presetId: "c1",
          title: "T",
          sportKey: "nba",
          themeBadge: "NBA",
          combinedDecimalOdds: "3.0000",
          combinedAmericanOdds: 200,
          combinedFairProbability: "0.3500",
          combinedEv: "0.0500",
          hybridValueScore: 50,
          commenceTime: "2026-11-16T01:15:00Z",
          legs: [{ ...baseLeg, ...legOverrides }],
        },
      ],
    });

    it("coerces null hitRateDisplay (camelCase) to null, not empty string", () => {
      const feed = normalizeCuratedPresetFeed(feedWith({ hitRateDisplay: null }));
      const leg = feed!.cards[0].legs[0];
      expect(leg.hitRateDisplay).toBeNull();
      expect(leg.sofascoreForm).toEqual([]);
      expect(leg.sofascoreDots).toBe("");
    });

    it("coerces null hit_rate_display (snake_case) and missing keys to null", () => {
      const snake = normalizeCuratedPresetFeed(
        feedWith({ hit_rate_display: null, sofascore_form: [], sofascore_dots: "" }),
      );
      expect(snake!.cards[0].legs[0].hitRateDisplay).toBeNull();
      const missing = normalizeCuratedPresetFeed(feedWith({}));
      expect(missing!.cards[0].legs[0].hitRateDisplay).toBeNull();
      expect(String(missing!.cards[0].legs[0].hitRateDisplay)).not.toBe("undefined");
    });

    it("preserves real hit-rate display strings", () => {
      const feed = normalizeCuratedPresetFeed(
        feedWith({ hit_rate_display: "0/10 (0.0%) L10", hit_rate_l10: "0.0000" }),
      );
      expect(feed!.cards[0].legs[0].hitRateDisplay).toBe("0/10 (0.0%) L10");
    });

    it("renders a Limited history badge when hitRateDisplay is null", () => {
      const feed = normalizeCuratedPresetFeed(feedWith({ hitRateDisplay: null }))!;
      const html = renderToStaticMarkup(
        React.createElement(PresetCard, { card: feed.cards[0] }),
      );
      expect(html).toContain("Limited history");
    });

    it("hybrid score uses only legs with real hit rates and never a default", () => {
      expect(
        computeHybridValueScore(
          [{ hitRateL10: "0.6" }, { hitRateL10: "0.8" }, { hitRateL10: null }],
          0,
        ),
      ).toBe(Math.round(0.6 * 70 + 0.4 * 50));
      expect(computeHybridValueScore([{ hitRateL10: null }], 0)).toBe(50);
      expect(computeHybridValueScore([{ hitRateL10: "0" }], 0)).toBe(
        Math.round(0.4 * 50),
      );
    });
  });
});
