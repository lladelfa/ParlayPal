import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import { ParlayDrawerProvider } from "@/context/ParlayDrawerContext";
import { ParlayDrawer } from "./ParlayDrawer";

// Force the mobile bottom sheet open (isOpen && !isDocked) while keeping the real provider state.
vi.mock("@/context/ParlayDrawerContext", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/context/ParlayDrawerContext")>();
  return {
    ...mod,
    useParlayDrawer: () => ({ ...mod.useParlayDrawer(), isOpen: true, isDocked: false }),
  };
});

function leg(propId: string, playerName: string): ParlayLeg {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey: "player_anytime_td",
    marketDisplay: "Anytime Touchdown",
    selection: "OVER",
    lineValue: 0.5,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    fairProbability: "0.50000",
    guardedEv: "0.0200",
  };
}

function renderDrawer(): string {
  return renderToStaticMarkup(
    <ParlayDrawerProvider
      initialLegs={[leg("a", "Player A"), leg("b", "Player B"), leg("c", "Player C"), leg("d", "Player D")]}
    >
      <ParlayDrawer />
    </ParlayDrawerProvider>,
  );
}

// Class list of the first element in `markup` whose opening tag matches `tagPattern`.
function classesOf(markup: string, tagPattern: RegExp): string[] {
  const tag = markup.match(tagPattern)?.[0];
  expect(tag, `no element matching ${tagPattern}`).toBeDefined();
  const cls = tag?.match(/class="([^"]*)"/)?.[1] ?? "";
  return cls.split(/\s+/);
}

describe("ParlayDrawer scroll containment", () => {
  it("caps the sticky desktop rail at the viewport and scrolls it internally", () => {
    const classes = classesOf(renderDrawer(), /<aside[^>]*aria-label="Parlay Slip Drawer"[^>]*>/);
    expect(classes).toContain("sticky");
    expect(classes).toContain("max-h-[calc(100vh-3rem)]");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overscroll-contain");
  });

  it("lets the mobile sheet body shrink so it scrolls instead of being clipped", () => {
    const html = renderDrawer();
    const sheetPattern = /<div class="[^"]*max-h-\[85dvh\][^"]*"[^>]*>/;
    const sheet = classesOf(html, sheetPattern);
    expect(sheet).toContain("overflow-hidden");
    expect(sheet).toContain("flex-col");
    // Search only inside the sheet so the desktop rail's markup can't satisfy the match.
    const sheetMarkup = html.slice(html.search(sheetPattern));
    const body = classesOf(sheetMarkup, /<div class="[^"]*\boverflow-y-auto\b[^"]*"[^>]*>/);
    expect(body).toContain("flex-1");
    expect(body).toContain("min-h-0");
    expect(body).toContain("overscroll-contain");
  });
});
