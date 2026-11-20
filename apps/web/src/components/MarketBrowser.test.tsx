import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MarketBrowser,
  SlateGameCard,
  resolveGameParam,
  withGameParam,
} from "./MarketBrowser";
import { FALLBACK_MARKET_BROWSER_FEED } from "@/lib/markets";
import type { ScheduledEventSummary } from "@/types/market";

vi.mock("@/context/ParlayDrawerContext", () => ({
  useParlayDrawer: () => ({
    slip: { legs: [] },
    addMarketProp: () => {},
    setCandidatePool: () => {},
  }),
}));

const games = FALLBACK_MARKET_BROWSER_FEED.games;
const nflFull = games.find((g) => g.eventId.startsWith("e4444"))!;
const nbaNoLines = games.find((g) => g.eventId.startsWith("e3333"))!;
const pickem = games.find((g) => g.eventId.startsWith("e2222"))!;

describe("SlateGameCard", () => {
  it("renders teams, props count and the full Spread / Money / Total grid", () => {
    const markup = renderToStaticMarkup(
      <SlateGameCard game={nflFull} selected={false} onSelect={() => {}} />,
    );
    expect(markup).toContain("BUF");
    expect(markup).toContain("NYJ");
    expect(markup).toContain("+3.5 -110");
    expect(markup).toContain("-3.5 -110");
    expect(markup).toContain("+140");
    expect(markup).toContain("-165");
    expect(markup).toContain("O 45.5 -110");
    expect(markup).toContain("U 45.5 -110");
    expect(markup).toContain('aria-pressed="false"');
  });

  it("shows em dashes for every cell when a game has no lines", () => {
    const markup = renderToStaticMarkup(
      <SlateGameCard game={nbaNoLines} selected={false} onSelect={() => {}} />,
    );
    expect(markup.match(/—/g)?.length).toBe(6);
  });

  it("shows partial lines with dashes only for missing markets", () => {
    const partial: ScheduledEventSummary = {
      ...nflFull,
      lines: {
        spread: null,
        moneyline: null,
        total: nflFull.lines!.total,
      },
    };
    const markup = renderToStaticMarkup(
      <SlateGameCard game={partial} selected={false} onSelect={() => {}} />,
    );
    expect(markup.match(/—/g)?.length).toBe(4);
    expect(markup).toContain("O 45.5 -110");
  });

  it("renders pick'em as PK, not a dash", () => {
    const markup = renderToStaticMarkup(
      <SlateGameCard game={pickem} selected={false} onSelect={() => {}} />,
    );
    expect(markup).toContain("PK -110");
  });

  it("marks the selected card as pressed", () => {
    const markup = renderToStaticMarkup(
      <SlateGameCard game={nflFull} selected onSelect={() => {}} />,
    );
    expect(markup).toContain('aria-pressed="true"');
  });
});

describe("game param helpers", () => {
  it("resolves a known game id and ignores unknown ones", () => {
    expect(resolveGameParam(games, nflFull.eventId)).toBe(nflFull.eventId);
    expect(resolveGameParam(games, "nope")).toBeNull();
    expect(resolveGameParam(games, null)).toBeNull();
  });

  it("sets and clears ?game= while preserving other params and hash", () => {
    expect(withGameParam("/browse", "?sport=nfl", "#x", "g1")).toBe(
      "/browse?sport=nfl&game=g1#x",
    );
    expect(withGameParam("/browse", "?sport=nfl&game=g1", "", null)).toBe(
      "/browse?sport=nfl",
    );
    expect(withGameParam("/browse", "?game=g1", "", null)).toBe("/browse");
  });
});

describe("MarketBrowser", () => {
  it("renders the game slate with lines and no selection by default", () => {
    const markup = renderToStaticMarkup(
      <MarketBrowser initialFeed={FALLBACK_MARKET_BROWSER_FEED} />,
    );
    expect(markup).toContain("Upcoming Slate");
    expect(markup).toContain("BUF @ NYJ");
    expect(markup).toContain("O 45.5 -110");
    expect(markup).not.toContain('aria-pressed="true"');
    expect(markup).toContain("Derrick Henry");
  });
});
