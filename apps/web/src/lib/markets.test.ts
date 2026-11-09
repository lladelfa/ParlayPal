import { describe, expect, it } from "vitest";
import {
  FALLBACK_MARKET_BROWSER_FEED,
  filterMarketProps,
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
});
