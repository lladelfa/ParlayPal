import { describe, expect, it } from "vitest";
import {
  formatAmerican,
  formatMoney,
  formatSpread,
  formatTotal,
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
