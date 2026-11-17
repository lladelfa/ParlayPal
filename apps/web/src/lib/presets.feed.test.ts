import { afterEach, describe, expect, it } from "vitest";
import { getCuratedPresetFeed, FALLBACK_PRESET_FEED } from "./presets";
import { getMarketBrowserFeed } from "./markets";
import { setRedisClientFactory, type RedisClient } from "./redis";

function fakeRedis(store: Record<string, string>): RedisClient {
  return {
    get: async (key: string) => store[key] ?? null,
    set: async () => "OK",
    quit: async () => "OK",
    disconnect: () => {},
  };
}

afterEach(() => {
  setRedisClientFactory(null);
  delete process.env.PARLAYPAL_SAMPLE_DATA;
});

describe("getCuratedPresetFeed honesty", () => {
  it("returns live cards with reason live", async () => {
    const card = FALLBACK_PRESET_FEED.cards[0];
    setRedisClientFactory(() =>
      fakeRedis({
        "presets:feed:all": JSON.stringify({
          generatedAt: "2026-01-01T00:00:00Z",
          cards: [card],
        }),
      }),
    );
    const feed = await getCuratedPresetFeed();
    expect(feed.reason).toBe("live");
    expect(feed.cards).toHaveLength(1);
  });

  it("reports no_qualifying_presets for a present but empty feed", async () => {
    setRedisClientFactory(() =>
      fakeRedis({
        "presets:feed:all": JSON.stringify({ generatedAt: "2026-01-01T00:00:00Z", cards: [] }),
      }),
    );
    const feed = await getCuratedPresetFeed();
    expect(feed.reason).toBe("no_qualifying_presets");
    expect(feed.cards).toEqual([]);
  });

  it("reports feed_unavailable when no key exists", async () => {
    setRedisClientFactory(() => fakeRedis({}));
    const feed = await getCuratedPresetFeed();
    expect(feed.reason).toBe("feed_unavailable");
    expect(feed.cards).toEqual([]);
  });

  it("reports feed_unavailable when redis throws", async () => {
    setRedisClientFactory(() => ({
      ...fakeRedis({}),
      get: async () => {
        throw new Error("down");
      },
    }));
    const feed = await getCuratedPresetFeed("nfl");
    expect(feed.reason).toBe("feed_unavailable");
    expect(feed.cards).toEqual([]);
  });

  it("serves labelled sample fixtures only behind the dev flag", async () => {
    process.env.PARLAYPAL_SAMPLE_DATA = "1";
    setRedisClientFactory(() => fakeRedis({}));
    const feed = await getCuratedPresetFeed("nfl");
    expect(feed.reason).toBe("sample");
    expect(feed.cards.length).toBeGreaterThan(0);
    expect(feed.cards.every((c) => c.sportKey === "nfl")).toBe(true);
  });
});

describe("getMarketBrowserFeed honesty", () => {
  it("does not serve fixture props without the dev flag", async () => {
    setRedisClientFactory(() => fakeRedis({}));
    const feed = await getMarketBrowserFeed();
    expect(feed.props).toEqual([]);
    expect(feed.games).toEqual([]);
  });

  it("serves fixtures behind the dev flag", async () => {
    process.env.PARLAYPAL_SAMPLE_DATA = "1";
    setRedisClientFactory(() => fakeRedis({}));
    const feed = await getMarketBrowserFeed();
    expect(feed.props.length).toBeGreaterThan(0);
  });
});
