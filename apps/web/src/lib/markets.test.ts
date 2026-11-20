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

  it("filters by eventId", () => {
    const all = FALLBACK_MARKET_BROWSER_FEED.props;
    const res = filterMarketProps(all, { eventId: "e1111111-1111-1111-1111-111111111111" });
    expect(res.length).toBe(2);
    expect(filterMarketProps(all, { eventId: "unknown" })).toEqual([]);
  });

  it("normalizes game lines in snake and camel case, keeping zero and null", () => {
    const feed = normalizeMarketBrowserFeed({
      props: [],
      games: [
        {
          event_id: "g1",
          lines: {
            spread: {
              home: { point: "0.00", decimal_odds: "1.9091", american_odds: -110 },
              away: { point: "0.00", decimalOdds: "1.9091", americanOdds: -110 },
            },
            moneyline: {
              home: null,
              away: { point: null, decimalOdds: "2.4000", americanOdds: 140 },
            },
            total: null,
          },
        },
        { eventId: "g2" },
      ],
    });
    const g1 = feed!.games[0].lines!;
    expect(g1.spread!.home!.point).toBe(0);
    expect(g1.spread!.home!.americanOdds).toBe(-110);
    expect(g1.spread!.away!.decimalOdds).toBe("1.9091");
    expect(g1.moneyline!.home).toBeNull();
    expect(g1.moneyline!.away!.point).toBeNull();
    expect(g1.total).toBeNull();
    expect(feed!.games[1].lines).toEqual({ spread: null, moneyline: null, total: null });
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
