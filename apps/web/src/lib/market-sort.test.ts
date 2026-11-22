import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  parseSortParam,
  sortMarketProps,
  withSortParam,
} from "./market-sort";
import type { MarketPropRow } from "@/types/market";

function row(over: Partial<MarketPropRow>): MarketPropRow {
  return {
    propId: "p",
    eventId: "e",
    sportKey: "nfl",
    playerName: "Zed",
    teamAbbreviation: "KC",
    matchup: "KC @ BUF",
    commenceTime: "2026-11-22T18:00:00Z",
    dateWindow: "today",
    marketKey: "player_pass_yds",
    marketLabel: "Passing Yards",
    marketDisplay: "Passing Yards",
    selection: "OVER",
    lineValue: 250.5,
    offeredDecimalOdds: "1.9100",
    offeredAmericanOdds: -110,
    fairProbability: "0.55",
    guardedEv: "0.02",
    hitRateL10: "0.6",
    hitRateDisplay: "6/10",
    sofascoreForm: [],
    sofascoreDots: "",
    hybridValueScore: 50,
    status: "ACTIVE",
    valueTier: "STANDARD",
    isHighValue: false,
    ...over,
  };
}

const ids = (rows: MarketPropRow[]) => rows.map((r) => r.propId);

describe("sortMarketProps", () => {
  const a = row({ propId: "a", playerName: "Ann", teamAbbreviation: "DAL", lineValue: 10, hitRateL10: "0.9", hybridValueScore: 40, guardedEv: "0.01", offeredDecimalOdds: "2.5000", marketDisplay: "Points" });
  const b = row({ propId: "b", playerName: "bob", teamAbbreviation: "BUF", lineValue: 30, hitRateL10: "0.5", hybridValueScore: 80, guardedEv: "0.05", offeredDecimalOdds: "1.8000", marketDisplay: "Rebounds" });
  const c = row({ propId: "c", playerName: "Cy", teamAbbreviation: "KC", lineValue: null, hitRateL10: null, hybridValueScore: 60, guardedEv: "0.03", offeredDecimalOdds: "2.0000", marketDisplay: "Threes" });

  it("sorts strings case-insensitively in both directions", () => {
    expect(ids(sortMarketProps([c, b, a], { field: "player", dir: "asc" }))).toEqual(["a", "b", "c"]);
    expect(ids(sortMarketProps([a, b, c], { field: "player", dir: "desc" }))).toEqual(["c", "b", "a"]);
  });

  it("sorts team and market", () => {
    expect(ids(sortMarketProps([a, b, c], { field: "team", dir: "asc" }))).toEqual(["b", "a", "c"]);
    expect(ids(sortMarketProps([a, b, c], { field: "market", dir: "asc" }))).toEqual(["a", "b", "c"]);
  });

  it("sorts numeric fields: line, odds, ev, score", () => {
    expect(ids(sortMarketProps([a, b], { field: "line", dir: "desc" }))).toEqual(["b", "a"]);
    expect(ids(sortMarketProps([a, b, c], { field: "odds", dir: "desc" }))).toEqual(["a", "c", "b"]);
    expect(ids(sortMarketProps([a, b, c], { field: "ev", dir: "desc" }))).toEqual(["b", "c", "a"]);
    expect(ids(sortMarketProps([a, b, c], { field: "score", dir: "asc" }))).toEqual(["a", "c", "b"]);
  });

  it("keeps missing hit rate and line last in both directions", () => {
    expect(ids(sortMarketProps([c, a, b], { field: "hitRate", dir: "asc" }))).toEqual(["b", "a", "c"]);
    expect(ids(sortMarketProps([c, a, b], { field: "hitRate", dir: "desc" }))).toEqual(["a", "b", "c"]);
    expect(ids(sortMarketProps([c, a, b], { field: "line", dir: "asc" }))).toEqual(["a", "b", "c"]);
    expect(ids(sortMarketProps([c, a, b], { field: "line", dir: "desc" }))).toEqual(["b", "a", "c"]);
  });

  it("treats blank hit rate as missing", () => {
    const blank = row({ propId: "x", hitRateL10: "" });
    expect(ids(sortMarketProps([blank, a], { field: "hitRate", dir: "desc" }))).toEqual(["a", "x"]);
  });

  it("is stable on ties and does not mutate its input", () => {
    const t1 = row({ propId: "t1", hybridValueScore: 10 });
    const t2 = row({ propId: "t2", hybridValueScore: 10 });
    const input = [t1, t2];
    expect(ids(sortMarketProps(input, { field: "score", dir: "desc" }))).toEqual(["t1", "t2"]);
    expect(ids(input)).toEqual(["t1", "t2"]);
  });
});

describe("parseSortParam", () => {
  it("defaults to score desc", () => {
    expect(DEFAULT_SORT).toEqual({ field: "score", dir: "desc" });
    expect(parseSortParam("")).toEqual(DEFAULT_SORT);
  });

  it("reads a valid field and direction", () => {
    expect(parseSortParam("?sort=player&dir=asc")).toEqual({ field: "player", dir: "asc" });
  });

  it("falls back for unknown field and bad direction", () => {
    expect(parseSortParam("?sort=bogus&dir=asc")).toEqual(DEFAULT_SORT);
    expect(parseSortParam("?sort=ev&dir=sideways")).toEqual({ field: "ev", dir: "desc" });
  });
});

describe("withSortParam", () => {
  it("omits params for the default sort and keeps other params and hash", () => {
    expect(withSortParam("/", "?game=g1&sort=ev&dir=asc", "#x", DEFAULT_SORT)).toBe("/?game=g1#x");
  });

  it("writes sort and dir, preserving game", () => {
    expect(withSortParam("/", "?game=g1", "", { field: "ev", dir: "asc" })).toBe(
      "/?game=g1&sort=ev&dir=asc",
    );
  });
});
