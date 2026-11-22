import { describe, expect, it } from "vitest";
import {
  compareToLine,
  gameLogKey,
  parseGameLog,
  readGameLogs,
} from "./game-logs";
import { FALLBACK_MARKET_BROWSER_FEED } from "./markets";
import type { RedisClient } from "./redis";

describe("gameLogKey", () => {
  it("mirrors the worker key with the upstream sport key", () => {
    expect(gameLogKey("nba", "Jayson Tatum", "player_points")).toBe(
      "gamelog:basketball_nba:Jayson Tatum:player_points",
    );
    expect(gameLogKey("nfl", "Josh Allen", "player_pass_yds")).toBe(
      "gamelog:americanfootball_nfl:Josh Allen:player_pass_yds",
    );
  });
});

describe("parseGameLog", () => {
  it("parses a list of decimal strings, newest first", () => {
    expect(parseGameLog('["30","25.5","28","31","22"]')).toEqual([30, 25.5, 28, 31, 22]);
  });
  it("returns null for null, missing, short, or invalid payloads", () => {
    expect(parseGameLog(null)).toBeNull();
    expect(parseGameLog("null")).toBeNull();
    expect(parseGameLog('["1","2","3","4"]')).toBeNull();
    expect(parseGameLog("not json")).toBeNull();
    expect(parseGameLog('["a","2","3","4","5"]')).toBeNull();
    expect(parseGameLog('["","2","3","4","5"]')).toBeNull();
  });
});

describe("compareToLine", () => {
  it("marks over, under and push", () => {
    expect(compareToLine(26, 25.5)).toBe("over");
    expect(compareToLine(25, 25.5)).toBe("under");
    expect(compareToLine(25.5, 25.5)).toBe("push");
  });
  it("returns null when the line is missing", () => {
    expect(compareToLine(25, null)).toBeNull();
    expect(compareToLine(25, undefined)).toBeNull();
  });
});

describe("readGameLogs", () => {
  const props = FALLBACK_MARKET_BROWSER_FEED.props.slice(0, 2);

  it("maps propId to stats, null when absent", async () => {
    const first = props[0];
    const key = gameLogKey(first.sportKey, first.playerName, first.marketKey);
    const redis = {
      get: async (k: string) => (k === key ? '["1","2","3","4","5"]' : null),
    } as unknown as RedisClient;
    const out = await readGameLogs(redis, props);
    expect(out[first.propId]).toEqual([1, 2, 3, 4, 5]);
    expect(out[props[1].propId]).toBeNull();
  });

  it("degrades to null when a read throws", async () => {
    const redis = {
      get: async () => {
        throw new Error("boom");
      },
    } as unknown as RedisClient;
    const out = await readGameLogs(redis, props);
    expect(Object.values(out).every((v) => v === null)).toBe(true);
  });
});
