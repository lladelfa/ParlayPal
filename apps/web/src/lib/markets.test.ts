import { describe, expect, it } from "vitest";
import {
  FALLBACK_MARKET_BROWSER_FEED,
  filterMarketProps,
  normalizeMarketBrowserFeed,
  recalculateMarketPropRow,
} from "./markets";

describe("markets library", () => {
  it("filters props by sport and canonical market correctly", () => {
    const all = FALLBACK_MARKET_BROWSER_FEED.props;
    const nbaPoints = filterMarketProps(all, {
      sport: "nba",
      market: "player_points",
    });

    expect(nbaPoints.length).toBeGreaterThan(0);
    expect(nbaPoints.every((p) => p.sportKey === "nba")).toBe(true);
    expect(nbaPoints.every((p) => p.marketKey === "player_points")).toBe(true);
  });

  it("resets invalid market when switching sport", () => {
    const all = FALLBACK_MARKET_BROWSER_FEED.props;
    // player_points is not valid for NFL
    const res = filterMarketProps(all, {
      sport: "nfl",
      market: "player_points",
    });

    // Should return all NFL props, ignoring invalid market
    expect(res.every((p) => p.sportKey === "nfl")).toBe(true);
    expect(res.length).toBe(all.filter((p) => p.sportKey === "nfl").length);
  });

  it("filters by dateWindow", () => {
    const all = FALLBACK_MARKET_BROWSER_FEED.props;
    const today = filterMarketProps(all, { dateWindow: "today" });
    expect(today.every((p) => p.dateWindow === "today")).toBe(true);

    const weekend = filterMarketProps(all, { dateWindow: "weekend" });
    expect(weekend.every((p) => p.dateWindow === "weekend")).toBe(true);
  });

  it("filters by search query", () => {
    const all = FALLBACK_MARKET_BROWSER_FEED.props;
    const res = filterMarketProps(all, { query: "henry" });
    expect(res.length).toBe(1);
    expect(res[0].playerName).toBe("Derrick Henry");
  });

  it("recalculates prop row on live SSE odds delta", () => {
    const sample = FALLBACK_MARKET_BROWSER_FEED.props[0];
    const updated = recalculateMarketPropRow(sample, 2.1);

    expect(updated.offeredDecimalOdds).toBe("2.1000");
    expect(updated.offeredAmericanOdds).toBe(110);
    expect(parseFloat(updated.guardedEv)).toBeGreaterThan(0);
    expect(updated.hybridValueScore).toBeGreaterThanOrEqual(0);
    expect(updated.hybridValueScore).toBeLessThanOrEqual(100);
  });

  it("normalizes null/missing hit-rate display to null with empty dots (both key styles)", () => {
    const base = {
      propId: "p1",
      eventId: "e1",
      playerName: "Test Player",
    };
    const variants: Record<string, unknown>[] = [
      { ...base, hitRateDisplay: null },
      { prop_id: "p1", event_id: "e1", player_name: "T", hit_rate_display: null },
      { ...base },
    ];
    for (const row of variants) {
      const feed = normalizeMarketBrowserFeed({ props: [row] });
      const prop = feed!.props[0];
      expect(prop.hitRateDisplay).toBeNull();
      expect(prop.sofascoreDots).toBe("");
    }
  });

  it("recalculation with null hitRateL10 is EV-only and never HIGH_VALUE", () => {
    const sample = {
      ...FALLBACK_MARKET_BROWSER_FEED.props[0],
      hitRateL10: null,
      fairProbability: "0.5000",
    };
    const updated = recalculateMarketPropRow(sample, 2.08);
    // EV = 0.04 -> EV component = 0.04 * 1000 + 50 = 90
    expect(updated.hybridValueScore).toBe(90);
    expect(updated.valueTier).not.toBe("HIGH_VALUE");
    expect(updated.isHighValue).toBe(false);
  });
});
