import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import type { SportsbookId } from "@/types/lineshopper";
import {
  ParlayDrawerProvider,
  useParlayDrawer,
} from "./ParlayDrawerContext";

// Minimal DOM mock required by React 19 createRoot in Node test environment
function createMockNode(type = 1, name = "DIV") {
  return {
    nodeType: type,
    nodeName: name,
    tagName: name,
    style: {},
    childNodes: [] as any[],
    ownerDocument: null as any,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: function (c: any) {
      this.childNodes.push(c);
      return c;
    },
    removeChild: function (c: any) {
      return c;
    },
    insertBefore: function (c: any) {
      this.childNodes.push(c);
      return c;
    },
    setAttribute: () => {},
  };
}

const mockDoc: any = {
  ...createMockNode(9, "#document"),
  activeElement: null,
  createElement: (tag: string) => createMockNode(1, tag.toUpperCase()),
  createTextNode: (t: string) => ({ ...createMockNode(3, "#text"), textContent: t }),
  createComment: (c: string) => ({ ...createMockNode(8, "#comment"), textContent: c }),
};

const mockWin: any = {
  document: mockDoc,
  HTMLIFrameElement: class {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

mockDoc.defaultView = mockWin;
(globalThis as any).window = mockWin;
(globalThis as any).document = mockDoc;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockLeg(
  propId: string,
  quotes?: Partial<Record<SportsbookId, { decimalOdds: number; isAvailable?: boolean }>>,
): ParlayLeg {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName: `Player ${propId}`,
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
    sportsbookQuotes: quotes
      ? (Object.fromEntries(
          Object.entries(quotes).map(([k, v]) => [
            k,
            {
              sportsbook: k as SportsbookId,
              sportsbookId: k as SportsbookId,
              decimalOdds: v.decimalOdds,
              isAvailable: v.isAvailable ?? true,
            },
          ]),
        ) as ParlayLeg["sportsbookQuotes"])
      : undefined,
  };
}

describe("ParlayDrawerContext Lineshopper State", () => {
  let latestContext: ReturnType<typeof useParlayDrawer>;

  function TestConsumer() {
    latestContext = useParlayDrawer();
    return null;
  }

  function renderContext() {
    const container = createMockNode(1, "DIV");
    container.ownerDocument = mockDoc;
    const root = createRoot(container as any);
    act(() => {
      root.render(
        <ParlayDrawerProvider>
          <TestConsumer />
        </ParlayDrawerProvider>,
      );
    });
    return { root };
  }

  it("auto-defaults selectedSportsbook to the Best Value Book when legs evaluate", () => {
    renderContext();

    // Leg 1 and 2 configured so DraftKings offers the highest payout (5.52 vs FD 4.0)
    const leg1 = createMockLeg("leg-1", {
      draftkings: { decimalOdds: 2.40 },
      fanduel: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });
    const leg2 = createMockLeg("leg-2", {
      draftkings: { decimalOdds: 2.30 },
      fanduel: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });

    act(() => {
      latestContext.addLeg(leg1);
    });
    act(() => {
      latestContext.addLeg(leg2);
    });

    expect(latestContext.lineshopperComparison.bestValueBookId).toBe("draftkings");
    expect(latestContext.selectedSportsbook).toBe("draftkings");
  });

  it("retains manual selection override when user explicitly chooses a sportsbook", () => {
    renderContext();

    // DraftKings is best value book
    const leg1 = createMockLeg("leg-1", {
      draftkings: { decimalOdds: 2.40 },
      fanduel: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });
    const leg2 = createMockLeg("leg-2", {
      draftkings: { decimalOdds: 2.30 },
      fanduel: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });

    act(() => {
      latestContext.addLeg(leg1);
    });
    act(() => {
      latestContext.addLeg(leg2);
    });
    expect(latestContext.selectedSportsbook).toBe("draftkings");

    // User manually clicks and selects BetMGM
    act(() => {
      latestContext.setSelectedSportsbook("betmgm");
    });
    expect(latestContext.selectedSportsbook).toBe("betmgm");

    // Add another leg where DraftKings is still best value
    const leg3 = createMockLeg("leg-3", {
      draftkings: { decimalOdds: 2.00 },
      fanduel: { decimalOdds: 1.80 },
      betmgm: { decimalOdds: 1.80 },
      caesars: { decimalOdds: 1.80 },
    });

    act(() => {
      latestContext.addLeg(leg3);
    });

    // Retains user override on BetMGM
    expect(latestContext.selectedSportsbook).toBe("betmgm");
  });

  it("falls back to an available bookmaker when the selected sportsbook becomes unavailable", () => {
    renderContext();

    const leg1 = createMockLeg("leg-1", {
      fanduel: { decimalOdds: 2.00 },
      draftkings: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });
    const leg2 = createMockLeg("leg-2", {
      fanduel: { decimalOdds: 2.00 },
      draftkings: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });

    act(() => {
      latestContext.addLeg(leg1);
    });
    act(() => {
      latestContext.addLeg(leg2);
    });

    // User chooses Caesars
    act(() => {
      latestContext.setSelectedSportsbook("caesars");
    });
    expect(latestContext.selectedSportsbook).toBe("caesars");

    // Add Leg 3 where Caesars has no line available
    const leg3 = createMockLeg("leg-3", {
      fanduel: { decimalOdds: 2.00 },
      draftkings: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 0, isAvailable: false },
    });

    act(() => {
      latestContext.addLeg(leg3);
    });

    // Caesars is now unavailable for the 3-leg ticket
    expect(latestContext.lineshopperComparison.bookmakers.caesars.isAvailable).toBe(false);

    // Context must automatically fall back to an available bookmaker
    expect(latestContext.selectedSportsbook).not.toBe("caesars");
    expect(
      latestContext.lineshopperComparison.bookmakers[latestContext.selectedSportsbook].isAvailable,
    ).toBe(true);
  });
});
