import { describe, expect, it } from "vitest";
import {
  formatAmerican,
  formatMoney,
  formatSpread,
  formatTotal,
  filterByTab,
  marketTabs,
} from "./market-filters";

const price = (point: number | null, americanOdds: number) => ({
  point,
  decimalOdds: "1.9091",
  americanOdds,
});

describe("main line formatting", () => {
  it("formats American odds with explicit plus", () => {
    expect(formatAmerican(140)).toBe("+140");
    expect(formatAmerican(-110)).toBe("-110");
  });

  it("formats spreads with sign and price", () => {
    expect(formatSpread(price(3.5, -110))).toBe("+3.5 -110");
    expect(formatSpread(price(-3.5, -110))).toBe("-3.5 -110");
  });

  it("shows pick'em as PK, not a dash", () => {
    expect(formatSpread(price(0, -110))).toBe("PK -110");
  });

  it("formats moneyline", () => {
    expect(formatMoney(price(null, 140))).toBe("+140");
    expect(formatMoney(price(null, -165))).toBe("-165");
  });

  it("formats totals with O/U prefix", () => {
    expect(formatTotal(price(45.5, -110), "O")).toBe("O 45.5 -110");
    expect(formatTotal(price(45.5, -110), "U")).toBe("U 45.5 -110");
  });

  it("renders missing cells as an em dash", () => {
    expect(formatSpread(null)).toBe("—");
    expect(formatSpread(undefined)).toBe("—");
    expect(formatMoney(null)).toBe("—");
    expect(formatTotal(null, "O")).toBe("—");
    expect(formatSpread(price(null, -110))).toBe("—");
  });
});

describe("filterByTab", () => {
  it("keeps all for 'all' and restricts to one market otherwise", () => {
    const rows = [
      { propId: "a", marketKey: "player_points" },
      { propId: "b", marketKey: "player_threes" },
    ] as never[];
    expect(filterByTab(rows, "all")).toHaveLength(2);
    expect(filterByTab(rows, "player_threes")).toEqual([rows[1]]);
    expect(filterByTab(rows, "player_rebounds")).toEqual([]);
  });
});

describe("marketTabs", () => {
  it("returns only markets that have props, in canonical order, with labels", () => {
    const mk = (marketKey: string, sportKey: "nfl" | "nba") =>
      ({ marketKey, sportKey, marketLabel: marketKey }) as never;
    const tabs = marketTabs([
      mk("player_threes", "nba"),
      mk("player_points", "nba"),
      mk("player_points", "nba"),
    ]);
    expect(tabs).toEqual([
      { key: "player_points", label: "Points" },
      { key: "player_threes", label: "Threes" },
    ]);
    expect(marketTabs([])).toEqual([]);
  });
});
