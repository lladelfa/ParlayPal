import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GameDetailView, PlayerHistory } from "./GameDetail";
import { FALLBACK_MARKET_BROWSER_FEED } from "@/lib/markets";

vi.mock("@/context/ParlayDrawerContext", () => ({
  useParlayDrawer: () => ({
    slip: { legs: [] },
    addMarketProp: () => {},
    setCandidatePool: () => {},
  }),
  ParlayDrawerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./ParlayDrawer", () => ({ ParlayDrawer: () => null }));
vi.mock("./LegSwapperModal", () => ({ LegSwapperModal: () => null }));

const game = FALLBACK_MARKET_BROWSER_FEED.games.find((g) => g.eventId.startsWith("e1111"))!;
const props = FALLBACK_MARKET_BROWSER_FEED.props.filter((p) => p.eventId === game.eventId);

describe("GameDetailView", () => {
  it("renders header, main lines, market tabs and prop rows", () => {
    const logs = Object.fromEntries(props.map((p) => [p.propId, null]));
    const markup = renderToStaticMarkup(
      <GameDetailView game={game} props={props} logs={logs} />,
    );
    expect(markup).toContain("BOS @ NYK");
    expect(markup).toContain("+2.5 -110");
    expect(markup).toContain("O 224.5 -110");
    expect(markup).toContain("All");
    expect(markup).toContain(props[0].playerName);
    expect(markup).toContain("Add to Slip");
    expect(markup).toContain("Limited history");
  });

  it("offers the Recent games toggle when a log is cached", () => {
    const logs = Object.fromEntries(props.map((p) => [p.propId, [20, 21, 22, 23, 24]]));
    const markup = renderToStaticMarkup(
      <GameDetailView game={game} props={props} logs={logs} />,
    );
    expect(markup).toContain("Recent games");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("shows em dashes for missing lines and a no-props message", () => {
    const bare = { ...game, lines: undefined };
    const markup = renderToStaticMarkup(
      <GameDetailView game={bare} props={[]} logs={{}} />,
    );
    expect(markup).toContain("—");
    expect(markup).toContain("No props");
  });
});

describe("PlayerHistory", () => {
  it("lists values newest first with over/under marks", () => {
    const markup = renderToStaticMarkup(
      <PlayerHistory stats={[30, 20, 25.5, 31, 22]} line={25.5} />,
    );
    expect(markup.indexOf("30")).toBeLessThan(markup.indexOf("20"));
    expect(markup).toContain("Over");
    expect(markup).toContain("Under");
    expect(markup).toContain("Push");
  });
  it("shows Limited history when there is no log", () => {
    expect(renderToStaticMarkup(<PlayerHistory stats={null} line={10} />)).toContain(
      "Limited history",
    );
  });
});
