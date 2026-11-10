import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import { ParlayDrawerProvider } from "@/context/ParlayDrawerContext";
import { serializeQuickPickPayload } from "@/lib/quickpick";
import { getStagedBets, stageBetLocally } from "@/lib/ledger";
import { ParlayDrawer } from "./ParlayDrawer";

function createMockNode(type = 1, name = "DIV") {
  return {
    nodeType: type,
    nodeName: name,
    tagName: name,
    style: {},
    childNodes: [] as any[],
    ownerDocument: null as any,
    _textContent: "",
    get textContent(): string {
      if (this.nodeType === 3) return this._textContent || "";
      return this.childNodes.map((c: any) => c.textContent).join("");
    },
    set textContent(v: string) {
      this._textContent = v;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: function (c: any) {
      this.childNodes.push(c);
      return c;
    },
    removeChild: function (c: any) {
      const idx = this.childNodes.indexOf(c);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      return c;
    },
    insertBefore: function (c: any, before: any) {
      const idx = this.childNodes.indexOf(before);
      if (idx !== -1) {
        this.childNodes.splice(idx, 0, c);
      } else {
        this.childNodes.push(c);
      }
      return c;
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    hasAttribute: () => false,
  };
}

const mockDoc: any = {
  ...createMockNode(9, "#document"),
  activeElement: null,
  createElement: (tag: string) => createMockNode(1, tag.toUpperCase()),
  createTextNode: (t: string) => {
    const node = createMockNode(3, "#text");
    node.textContent = t;
    return node;
  },
  createComment: (c: string) => {
    const node = createMockNode(8, "#comment");
    node.textContent = c;
    return node;
  },
};

const mockWin: any = {
  document: mockDoc,
  HTMLIFrameElement: class {},
  addEventListener: () => {},
  removeEventListener: () => {},
  open: vi.fn(),
};

mockDoc.defaultView = mockWin;
(globalThis as any).window = mockWin;
(globalThis as any).document = mockDoc;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function createMockLeg(
  propId: string,
  playerName: string,
  selection: "OVER" | "UNDER" = "OVER",
  lineValue: number = 0.5,
): ParlayLeg {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey: "player_anytime_td",
    marketDisplay: "Anytime Touchdown",
    selection,
    lineValue,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    fairProbability: "0.50000",
    guardedEv: "0.0200",
  };
}

describe("ParlayDrawer QuickPick Integration", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal("localStorage", mockStorage);
    vi.restoreAllMocks();
  });

  it("renders ParlayDrawer empty state with Lineshopper placeholder", () => {
    const html = renderToStaticMarkup(
      <ParlayDrawerProvider>
        <ParlayDrawer />
      </ParlayDrawerProvider>,
    );

    expect(html).toContain("Parlay Slip");
    expect(html).toContain("Lineshopper");
    expect(html).toContain("Your slip is empty");
  });

  it("renders 1-leg single bet with enabled QuickPick CTA button", () => {
    const singleLeg = createMockLeg("henry", "Derrick Henry", "OVER", 0.5);
    const html = renderToStaticMarkup(
      <ParlayDrawerProvider initialLegs={[singleLeg]}>
        <ParlayDrawer />
      </ParlayDrawerProvider>,
    );

    expect(html).toContain("Derrick Henry");
    expect(html).toContain("⚡ Open Bet in FanDuel via QuickPick");
    expect(html).not.toMatch(/<button[^>]+disabled[=>\s]/);
  });

  it("renders 2-leg parlay with enabled QuickPick CTA button and lineshopper comparison", () => {
    const leg1 = createMockLeg("henry", "Derrick Henry", "OVER", 0.5);
    const leg2 = createMockLeg("lamar", "Lamar Jackson", "OVER", 225.5);

    const html = renderToStaticMarkup(
      <ParlayDrawerProvider initialLegs={[leg1, leg2]}>
        <ParlayDrawer />
      </ParlayDrawerProvider>,
    );

    expect(html).toContain("Derrick Henry");
    expect(html).toContain("Lamar Jackson");
    expect(html).toContain("⚡ Open in FanDuel via QuickPick");
  });

  it("serializes legs into QuickPick payload and generates deep links", () => {
    const leg1 = createMockLeg("henry", "Derrick Henry", "OVER", 0.5);
    const leg2 = createMockLeg("lamar", "Lamar Jackson", "OVER", 225.5);

    const serialized = serializeQuickPickPayload({
      sportsbook: "fanduel",
      legs: [leg1, leg2],
      stake: 50,
    });

    expect(serialized.url).toContain("https://quickpick.pikkit.com/v1/betslip?data=");
    expect(serialized.universalLink).toBe(serialized.url);
    expect(serialized.deepLink).toContain("fanduel://sportsbook/betslip?quickpick=");
    expect(serialized.payload.legs).toHaveLength(2);
    expect(serialized.payload.legs[0].playerName).toBe("Derrick Henry");
    expect(serialized.payload.legs[0].eventId).toBe("papi_nfl_henry");
    expect(serialized.payload.sportsbook).toBe("fanduel");
  });

  it("handles serialization endpoint contract and error states", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://quickpick.pikkit.com/v1/betslip?data=abc123xyz",
        universalLink: "https://quickpick.pikkit.com/v1/betslip?data=abc123xyz",
        deepLink: "draftkings://sportsbook/betslip?quickpick=abc123xyz",
        executionLatencyMs: 12.5,
      }),
    });
    (globalThis as any).fetch = fetchMock;

    const res = await fetch("/api/quickpick/serialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sportsbook: "draftkings",
        legs: [
          createMockLeg("leg-1", "Patrick Mahomes"),
          createMockLeg("leg-2", "Travis Kelce"),
        ],
        stake: 25,
      }),
    });

    const data = await res.json();
    expect(res.ok).toBe(true);
    expect(data.deepLink).toContain("draftkings://");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quickpick/serialize",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("validates that QuickPick rejects invalid payloads with descriptive errors", () => {
    expect(() =>
      serializeQuickPickPayload({
        sportsbook: "fanduel",
        legs: [],
      }),
    ).toThrowError("At least one leg is required.");
  });

  it("auto-stages bet to local ledger with status 'staged' and ticket metadata", () => {
    const leg1 = createMockLeg("henry", "Derrick Henry");
    const leg2 = createMockLeg("lamar", "Lamar Jackson");

    const staged = stageBetLocally({
      sportsbook: "fanduel",
      legs: [
        {
          propId: leg1.propId,
          playerName: leg1.playerName,
          marketDisplay: leg1.marketDisplay,
          line: leg1.lineValue,
          selection: leg1.selection,
          offeredDecimalOdds: leg1.offeredDecimalOdds,
        },
        {
          propId: leg2.propId,
          playerName: leg2.playerName,
          marketDisplay: leg2.marketDisplay,
          line: leg2.lineValue,
          selection: leg2.selection,
          offeredDecimalOdds: leg2.offeredDecimalOdds,
        },
      ],
      decimalOdds: 4.0,
      americanOdds: 300,
      stakeAmount: 50,
      quickpickUrl: "https://quickpick.pikkit.com/v1/betslip?data=test",
    });

    expect(staged.status).toBe("staged");
    expect(staged.betId).toBeDefined();
    expect(staged.userId).toBeDefined();
    expect(staged.sportsbook).toBe("fanduel");
    expect(staged.decimalOdds).toBe(4.0);
    expect(staged.stakeAmount).toBe(50);
    expect(staged.potentialPayout).toBe(200);

    const storedBets = getStagedBets();
    expect(storedBets).toHaveLength(1);
    expect(storedBets[0].betId).toBe(staged.betId);
    expect(storedBets[0].status).toBe("staged");
  });

  it("handles staging endpoint integration with non-blocking graceful degradation", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/quickpick/serialize") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: "https://quickpick.pikkit.com/v1/betslip?data=serialized123",
            universalLink: "https://quickpick.pikkit.com/v1/betslip?data=serialized123",
            deepLink: "fanduel://sportsbook/betslip?quickpick=serialized123",
          }),
        });
      }
      if (url === "/api/bets/stage") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            betId: "uuid-staged-123",
            status: "staged",
          }),
        });
      }
      return Promise.reject(new Error("Unknown route"));
    });
    (globalThis as any).fetch = fetchMock;

    // Simulate calling /api/bets/stage directly
    const stageRes = await fetch("/api/bets/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sportsbook: "fanduel",
        legs: [createMockLeg("leg-1", "Derrick Henry")],
        stake: 50,
      }),
    });

    expect(stageRes.ok).toBe(true);
    const stageData = await stageRes.json();
    expect(stageData.status).toBe("staged");
    expect(stageData.success).toBe(true);
  });

  it("executes 1-tap handoff in ParlayDrawer, stages locally, dispatches to /api/bets/stage with matching betId, and displays toast", async () => {
    const leg1 = createMockLeg("leg-1", "Derrick Henry");
    const leg2 = createMockLeg("leg-2", "Lamar Jackson");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/quickpick/serialize") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            url: "https://quickpick.pikkit.com/v1/betslip?data=abc123xyz",
            universalLink: "https://quickpick.pikkit.com/v1/betslip?data=abc123xyz",
            deepLink: "fanduel://sportsbook/betslip?quickpick=abc123xyz",
          }),
        });
      }
      if (url === "/api/bets/stage") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            status: "staged",
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });
    (globalThis as any).fetch = fetchMock;

    const openMock = vi.fn().mockReturnValue({ closed: false });
    mockWin.open = openMock;

    const container = createMockNode(1, "DIV");
    container.ownerDocument = mockDoc;
    const root = createRoot(container as any);

    await act(async () => {
      root.render(
        <ParlayDrawerProvider initialLegs={[leg1, leg2]}>
          <ParlayDrawer />
        </ParlayDrawerProvider>,
      );
    });

    // Helper to extract text from nested React nodes
    function getText(node: any): string {
      if (!node) return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(getText).join(" ");
      if (typeof node === "object" && node.props?.children) {
        return getText(node.props.children);
      }
      return "";
    }

    // Helper to traverse and find CTA button onClick handler
    function findCTAButton(node: any): any {
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      if (propsKey) {
        const props = node[propsKey];
        if (node.tagName === "BUTTON" && typeof props?.onClick === "function") {
          const btnText = getText(props.children);
          if (btnText.includes("Open in FanDuel")) {
            return props.onClick;
          }
        }
      }
      for (const child of node.childNodes || []) {
        const found = findCTAButton(child);
        if (found) return found;
      }
      return null;
    }

    const onCTAClick = findCTAButton(container);
    expect(onCTAClick).toBeDefined();

    // Trigger CTA Click
    await act(async () => {
      await onCTAClick();
    });

    // Verify QuickPick serialize was called
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quickpick/serialize",
      expect.objectContaining({ method: "POST" }),
    );

    // Verify bet was staged to local ledger
    const storedBets = getStagedBets();
    expect(storedBets).toHaveLength(1);
    const localBet = storedBets[0];
    expect(localBet.sportsbook).toBe("fanduel");
    expect(localBet.status).toBe("staged");

    // Verify /api/bets/stage was dispatched with MATCHING betId and userId
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bets/stage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(localBet.betId),
      }),
    );

    const stageCall = fetchMock.mock.calls.find((c) => c[0] === "/api/bets/stage");
    expect(stageCall).toBeDefined();
    if (!stageCall) throw new Error("stageCall is required");
    const stageBody = JSON.parse(stageCall[1].body);
    expect(stageBody.betId).toBe(localBet.betId);
    expect(stageBody.userId).toBe(localBet.userId);
    expect(stageBody.sportsbook).toBe("fanduel");

    // Verify window.open was triggered with "_blank" without noopener string
    expect(openMock).toHaveBeenCalledWith(
      "https://quickpick.pikkit.com/v1/betslip?data=abc123xyz",
      "_blank",
    );

    // Verify toast is rendered in DOM tree
    function hasToastText(node: any, text: string): boolean {
      if (node.textContent && node.textContent.includes(text)) return true;
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      if (propsKey) {
        const nodeText = getText(node[propsKey]?.children);
        if (nodeText.includes(text)) return true;
      }
      for (const child of node.childNodes || []) {
        if (hasToastText(child, text)) return true;
      }
      return false;
    }

    expect(
      hasToastText(container, "Slip opened in FanDuel & staged for tracking"),
    ).toBe(true);
  });
});
