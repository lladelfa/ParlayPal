import { afterEach, describe, expect, it, vi } from "vitest";
import { setRedisClientFactory, marketsBrowserKey, type RedisClient } from "./redis";
import {
  FALLBACK_MARKET_BROWSER_FEED,
  filterMarketProps,
  getGameDetail,
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

describe("getGameDetail", () => {
  afterEach(() => {
    setRedisClientFactory(null);
    vi.unstubAllEnvs();
  });
  const feed = FALLBACK_MARKET_BROWSER_FEED;
  const game = feed.games.find((g) => g.eventId.startsWith("e1111"))!;
  const fakeRedis = (store: Record<string, string>, fail = false): RedisClient =>
    ({
      connect: async () => {},
      get: async (k: string) => {
        if (fail) throw new Error("down");
        return store[k] ?? null;
      },
      disconnect: () => {},
      quit: async () => {},
    }) as unknown as RedisClient;

  it("returns the game, its props and logs", async () => {
    setRedisClientFactory(() =>
      fakeRedis({ [marketsBrowserKey()]: JSON.stringify(feed) }),
    );
    const detail = await getGameDetail(game.eventId);
    expect(detail?.game.eventId).toBe(game.eventId);
    expect(detail?.props.length).toBe(2);
    expect(detail?.props.every((p) => p.eventId === game.eventId)).toBe(true);
    expect(Object.keys(detail!.logs).length).toBe(2);
  });

  it("returns null for an unknown id", async () => {
    setRedisClientFactory(() =>
      fakeRedis({ [marketsBrowserKey()]: JSON.stringify(feed) }),
    );
    expect(await getGameDetail("nope")).toBeNull();
  });

  it("returns null for a game that has already started", async () => {
    const started = {
      ...feed,
      games: feed.games.map((g) =>
        g.eventId === game.eventId
          ? { ...g, commenceTime: new Date(Date.now() - 60_000).toISOString() }
          : g,
      ),
    };
    setRedisClientFactory(() =>
      fakeRedis({ [marketsBrowserKey()]: JSON.stringify(started) }),
    );
    expect(await getGameDetail(game.eventId)).toBeNull();
  });

  it("keeps the game with null logs when log reads fail", async () => {
    const feedKey = marketsBrowserKey();
    setRedisClientFactory(
      () =>
        ({
          connect: async () => {},
          get: async (k: string) => {
            if (k === feedKey) return JSON.stringify(feed);
            throw new Error("log read failed");
          },
          disconnect: () => {},
          quit: async () => {},
        }) as unknown as RedisClient,
    );
    const detail = await getGameDetail(game.eventId);
    expect(detail?.game.eventId).toBe(game.eventId);
    expect(Object.values(detail!.logs).every((v) => v === null)).toBe(true);
  });

  it("returns null when Redis is unreachable", async () => {
    vi.stubEnv("PARLAYPAL_SAMPLE_DATA", "");
    setRedisClientFactory(() => fakeRedis({}, true));
    expect(await getGameDetail(game.eventId)).toBeNull();
  });
});
