import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { TrackedBet } from "@/types/bet";
import { BetTrackerDashboard, performBetSettlement } from "./BetTrackerDashboard";
import { saveTrackedBet, getTrackedBets } from "@/lib/ledger";

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

describe("BetTrackerDashboard (apps/web/src/components/BetTrackerDashboard.tsx)", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal("localStorage", mockStorage);
  });

  const mockBets: TrackedBet[] = [
    {
      betId: "bet-staged-1",
      userId: "user-1",
      sportsbook: "DraftKings",
      decimalOdds: 3.5,
      americanOdds: 250,
      stakeAmount: 50,
      potentialPayout: 175,
      status: "staged",
      legs: [
        {
          propId: "p1",
          playerName: "Patrick Mahomes",
          marketDisplay: "Pass Yds Over 274.5",
          selection: "OVER",
          offeredDecimalOdds: 1.91,
          teamAbbreviation: "KC",
        },
      ],
      stagedAt: "2026-11-10T10:00:00.000Z",
    },
    {
      betId: "bet-pending-1",
      userId: "user-1",
      sportsbook: "FanDuel",
      decimalOdds: 2.8,
      americanOdds: 180,
      stakeAmount: 25,
      potentialPayout: 70,
      status: "pending",
      legs: [
        {
          propId: "p2",
          playerName: "Lamar Jackson",
          marketDisplay: "Rush Yds Over 54.5",
          selection: "OVER",
          offeredDecimalOdds: 1.87,
          teamAbbreviation: "BAL",
          liveProgress: {
            status: "in_progress",
            period: "Q3 4:12",
            scoreDisplay: "BAL 21, PIT 14",
          },
        },
      ],
      placedAt: "2026-11-10T11:00:00.000Z",
      liveProgress: {
        status: "in_progress",
        period: "Q3 4:12",
        scoreDisplay: "BAL 21, PIT 14",
      },
    },
    {
      betId: "bet-won-1",
      userId: "user-1",
      sportsbook: "BetMGM",
      decimalOdds: 2.5,
      americanOdds: 150,
      stakeAmount: 50,
      potentialPayout: 125,
      status: "won",
      legs: [
        {
          propId: "p3",
          playerName: "Travis Kelce",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          offeredDecimalOdds: 2.5,
          teamAbbreviation: "KC",
        },
      ],
      placedAt: "2026-11-10T09:00:00.000Z",
      settledAt: "2026-11-10T13:00:00.000Z",
    },
  ];

  it("renders empty state with CTA button when no bets are present", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={[]} onNavigate={() => {}} />,
    );

    expect(markup).toContain("No tracked bets yet");
    expect(markup).toContain("Explore Curated Presets");
  });

  it("renders metric summary cards correctly", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    // Total Bets = 3
    expect(markup).toContain("Total Bets");
    expect(markup).toContain("3");

    // Active Action = $25.00
    expect(markup).toContain("Active Action");
    expect(markup).toContain("$25.00");

    // Staged Slips = 1
    expect(markup).toContain("Staged Slips");
    expect(markup).toContain("1");

    // Net P/L = 125 (return) - 50 (settled stake) = +$75.00
    expect(markup).toContain("+$75.00");

    // ROI = (75 / 50) * 100 = +150.0%
    expect(markup).toContain("+150.0%");
  });

  it("renders all status filter tabs with respective counts", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("All (3)");
    expect(markup).toContain("Staged (1)");
    expect(markup).toContain("Pending / Live (1)");
    expect(markup).toContain("Won (1)");
    expect(markup).toContain("Lost (0)");
  });

  it("renders ticket cards with sportsbooks, odds, and leg details", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    // Sportsbooks
    expect(markup).toContain("DraftKings");
    expect(markup).toContain("FanDuel");
    expect(markup).toContain("BetMGM");

    // American odds
    expect(markup).toContain("+250");
    expect(markup).toContain("+180");
    expect(markup).toContain("+150");

    // Player legs
    expect(markup).toContain("Patrick Mahomes");
    expect(markup).toContain("Pass Yds Over 274.5");
    expect(markup).toContain("Lamar Jackson");
    expect(markup).toContain("Rush Yds Over 54.5");
    expect(markup).toContain("Travis Kelce");
    expect(markup).toContain("Anytime Touchdown");

    // Live score progress pill
    expect(markup).toContain("Q3 4:12 · BAL 21, PIT 14");

    // Potential payouts
    expect(markup).toContain("$175.00");
    expect(markup).toContain("$70.00");
    expect(markup).toContain("$125.00");
  });

  it("renders Staged Slip controls (Confirm Placed, Discard, stake input) on staged ticket", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("Staged Slip");
    expect(markup).toContain("Confirm Placed");
    expect(markup).toContain("Discard");
    expect(markup).toContain('aria-label="Stake amount"');
  });

  it("renders simulate settlement buttons for pending bets", () => {
    const markup = renderToStaticMarkup(
      <BetTrackerDashboard initialBets={mockBets} />,
    );

    expect(markup).toContain("Pending / Live");
    expect(markup).toContain("Simulate Settle:");
    expect(markup).toContain("Won");
    expect(markup).toContain("Lost");
  });

  it("loads persisted bets from localStorage when mounted without initialBets", () => {
    saveTrackedBet(mockBets[0]);
    saveTrackedBet(mockBets[1]);

    const markup = renderToStaticMarkup(<BetTrackerDashboard />);
    expect(markup).toContain("DraftKings");
    expect(markup).toContain("FanDuel");
  });

  describe("CLV Analytics, Edge Distribution & Per-Ticket CLV Badges", () => {
    it("renders zero-state Closing Line Beat Rate and Avg CLV% when no bets have CLV stamped", () => {
      const markup = renderToStaticMarkup(
        <BetTrackerDashboard initialBets={mockBets} />,
      );

      expect(markup).toContain("Closing Line Beat Rate");
      expect(markup).toContain("0.0%");
      expect(markup).toContain("0 of 0 bets beat closing line");
      expect(markup).toContain("Avg CLV%");
      expect(markup).toContain("ROI%");
    });

    it("renders Closing Line Beat Rate, stake-weighted Avg CLV% alongside ROI%, and By Sport / By Sportsbook breakdowns", () => {
      const clvBets: TrackedBet[] = [
        {
          betId: "clv-ui-1",
          userId: "user-1",
          sportsbook: "FanDuel",
          decimalOdds: 2.5,
          americanOdds: 150,
          stakeAmount: 50,
          potentialPayout: 125,
          status: "won",
          clvPercentage: 4.0,
          closingDecimalOdds: 2.4,
          closingFairProb: 0.416,
          legs: [
            {
              propId: "p-nfl-1",
              playerName: "Josh Allen",
              marketDisplay: "Pass Yds Over 264.5",
              selection: "OVER",
              offeredDecimalOdds: 2.5,
              sportKey: "americanfootball_nfl",
              marketKey: "player_pass_yds",
            },
          ],
          placedAt: "2026-11-10T10:00:00.000Z",
          settledAt: "2026-11-10T13:00:00.000Z",
        },
        {
          betId: "clv-ui-2",
          userId: "user-1",
          sportsbook: "DraftKings",
          decimalOdds: 3.1,
          americanOdds: 210,
          stakeAmount: 25,
          potentialPayout: 77.5,
          status: "pending",
          clvPercentage: 2.0,
          closingDecimalOdds: 3.04,
          closingFairProb: 0.32903,
          legs: [
            {
              propId: "p-nfl-2",
              playerName: "Derrick Henry",
              marketDisplay: "Anytime Touchdown",
              selection: "OVER",
              offeredDecimalOdds: 1.8,
              sportKey: "nfl",
              marketKey: "player_anytime_td",
            },
            {
              propId: "p-nba-2",
              playerName: "Luka Doncic",
              marketDisplay: "Points Over 29.5",
              selection: "OVER",
              offeredDecimalOdds: 1.72,
              sportKey: "nba",
              marketKey: "player_points",
            },
          ],
          placedAt: "2026-11-10T11:00:00.000Z",
        },
        {
          betId: "clv-ui-3",
          userId: "user-1",
          sportsbook: "BetMGM",
          decimalOdds: 1.91,
          americanOdds: -110,
          stakeAmount: 25,
          potentialPayout: 47.75,
          status: "lost",
          clvPercentage: -3.0,
          closingDecimalOdds: 1.97,
          closingFairProb: 0.50785,
          legs: [
            {
              propId: "p-nba-3",
              playerName: "Nikola Jokic",
              marketDisplay: "Rebounds Over 11.5",
              selection: "OVER",
              offeredDecimalOdds: 1.91,
              sportKey: "basketball_nba",
              marketKey: "player_rebounds",
            },
          ],
          placedAt: "2026-11-10T09:00:00.000Z",
          settledAt: "2026-11-10T12:00:00.000Z",
        },
      ];

      const markup = renderToStaticMarkup(
        <BetTrackerDashboard initialBets={clvBets} />,
      );

      // Headline CLV cards alongside ROI%
      expect(markup).toContain("Closing Line Beat Rate");
      expect(markup).toContain("66.7%");
      expect(markup).toContain("2 of 3 bets beat closing line");
      expect(markup).toContain("Avg CLV%");
      expect(markup).toContain("+1.75%");
      expect(markup).toContain("ROI%");

      // By Sport edge distribution
      expect(markup).toContain("By Sport");
      expect(markup).toContain("NFL");
      expect(markup).toContain("NBA");
      expect(markup).toContain("Multi-Sport");

      // By Sportsbook edge distribution
      expect(markup).toContain("By Sportsbook");
      expect(markup).toContain("FanDuel");
      expect(markup).toContain("DraftKings");
      expect(markup).toContain("BetMGM");

      // Per-ticket color-coded CLV badges & closing line benchmark details
      expect(markup).toContain("+4.0% CLV");
      expect(markup).toContain("+2.0% CLV");
      expect(markup).toContain("-3.0% CLV");
      expect(markup).toContain("#10b981");
      expect(markup).toContain("#ef4444");
      expect(markup).toContain("2.40x");
      expect(markup).toContain("3.04x");
      expect(markup).toContain("1.97x");
    });

    it("excludes >10.0% suspect CLV outliers from headline analytics and flags the card", () => {
      const outlierBets: TrackedBet[] = [
        {
          ...mockBets[2],
          betId: "clv-valid-pos",
          clvPercentage: 4.2,
          closingDecimalOdds: 2.4,
          closingFairProb: 0.4168,
        },
        {
          ...mockBets[2],
          betId: "clv-suspect-outlier",
          status: "pending",
          clvPercentage: 12.5,
          closingDecimalOdds: 2.22,
          closingFairProb: 0.45,
        },
      ];

      const markup = renderToStaticMarkup(
        <BetTrackerDashboard initialBets={outlierBets} />,
      );

      expect(markup).toContain("1 of 1 bets beat closing line");
      expect(markup).toContain("+4.2% CLV");
      expect(markup).toContain("Suspect CLV");
      expect(markup).not.toContain("+12.5% CLV");
    });

    it("performBetSettlement stamps simulated CLV on unstamped bet and includes CLV fields in PATCH payload", () => {
      const pendingBet: TrackedBet = {
        ...mockBets[1],
        betId: "bet-settle-patch-1",
        status: "pending",
        clvPercentage: undefined,
      };
      saveTrackedBet(pendingBet);

      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const settled = performBetSettlement(pendingBet, "won", mockFetch as unknown as typeof fetch);

      expect(settled.status).toBe("won");
      expect(settled.clvPercentage).toBeDefined();
      expect(settled.closingFairProb).toBeDefined();
      expect(settled.closingDecimalOdds).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/bets/bet-settle-patch-1");
      expect(init.method).toBe("PATCH");
      const sentBody = JSON.parse(init.body);
      expect(sentBody.status).toBe("won");
      expect(sentBody.clvPercentage).toBe(settled.clvPercentage);
      expect(sentBody.closingFairProb).toBe(settled.closingFairProb);
      expect(sentBody.closingDecimalOdds).toBe(settled.closingDecimalOdds);

      const stored = getTrackedBets().find((b) => b.betId === "bet-settle-patch-1");
      expect(stored?.clvPercentage).toBe(settled.clvPercentage);
    });
  });
});


describe("Story 4.3 Review Dashboard UI & Interactive Settlement Tests", () => {
  function createMockDomEnv() {
    class MockDomStorage implements Storage {
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

    const createMockNode = (nodeType: number, tagName: string, text = ""): any => {
      const node: any = {
        nodeType,
        tagName: tagName.toUpperCase(),
        nodeName: tagName.toUpperCase(),
        childNodes: [],
        attributes: {},
        style: {},
        _text: text,
        parentNode: null,
        ownerDocument: null,
        eventListeners: {},
        setAttribute(k: string, v: string) {
          this.attributes[k] = String(v);
        },
        removeAttribute(k: string) {
          delete this.attributes[k];
        },
        getAttribute(k: string) {
          return this.attributes[k] ?? null;
        },
        addEventListener(type: string, fn: any) {
          this.eventListeners[type] = this.eventListeners[type] || [];
          this.eventListeners[type].push(fn);
        },
        removeEventListener(type: string, fn: any) {
          if (this.eventListeners[type]) {
            this.eventListeners[type] = this.eventListeners[type].filter(
              (f: any) => f !== fn,
            );
          }
        },
        appendChild(child: any) {
          child.parentNode = this;
          this.childNodes.push(child);
          return child;
        },
        insertBefore(newNode: any, refNode: any) {
          newNode.parentNode = this;
          const idx = this.childNodes.indexOf(refNode);
          if (idx >= 0) {
            this.childNodes.splice(idx, 0, newNode);
          } else {
            this.childNodes.push(newNode);
          }
          return newNode;
        },
        removeChild(child: any) {
          const idx = this.childNodes.indexOf(child);
          if (idx >= 0) this.childNodes.splice(idx, 1);
          child.parentNode = null;
          return child;
        },
      };
      Object.defineProperty(node, "textContent", {
        get() {
          return node._text;
        },
        set(val: string) {
          node._text = String(val);
        },
      });
      return node;
    };

    const mockDoc: any = {
      nodeType: 9,
      createElement: (tag: string) => {
        const el = createMockNode(1, tag);
        el.ownerDocument = mockDoc;
        return el;
      },
      createElementNS: (_ns: string, tag: string) => {
        const el = createMockNode(1, tag);
        el.ownerDocument = mockDoc;
        return el;
      },
      createTextNode: (text: string) => {
        const tn = createMockNode(3, "#text", text);
        tn.ownerDocument = mockDoc;
        return tn;
      },
      createComment: (text: string) => {
        const cn = createMockNode(8, "#comment", text);
        cn.ownerDocument = mockDoc;
        return cn;
      },
      body: createMockNode(1, "BODY"),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    mockDoc.body.ownerDocument = mockDoc;
    class MockHTMLIFrameElement {}
    mockDoc.activeElement = null;
    mockDoc.defaultView = {
      document: mockDoc,
      location: { href: "http://localhost:3000" },
      HTMLIFrameElement: MockHTMLIFrameElement,
      HTMLElement: class MockHTMLElement {},
      Element: class MockElement {},
      Node: class MockNode {},
    };

    const storage = new MockDomStorage();
    return { mockDoc, storage, createMockNode };
  }

  it("renders bySportsbook telemetry, Unweighted label, Edge Verification Guard, closing odds/fair prob, zero/tiny CLV, accessible 0% progressbar, and STAGED suppression", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BetTrackerDashboard } = await import("./BetTrackerDashboard");

    const bets: TrackedBet[] = [
      {
        betId: "ui-dk-zero-clv",
        userId: "u-ui",
        sportsbook: "draftkings",
        decimalOdds: 2.0,
        americanOdds: 100,
        stakeAmount: 100,
        potentialPayout: 200,
        status: "lost",
        legs: [
          {
            propId: "p-1",
            sportKey: "nfl",
            playerName: "Josh Allen",
            marketDisplay: "Pass Yards Over 265.5",
            line: 265.5,
            selection: "OVER",
            offeredDecimalOdds: 2.0,
          },
        ],
        quickpickUrl: "",
        placedAt: "2026-11-14T18:00:00Z",
        closingDecimalOdds: 1.95,
        closingFairProb: 0.51282,
        clvPercentage: 0,
      },
      {
        betId: "ui-fd-tiny-clv",
        userId: "u-ui",
        sportsbook: "fanduel",
        decimalOdds: 1.91,
        americanOdds: -110,
        stakeAmount: 50,
        potentialPayout: 95.5,
        status: "won",
        legs: [
          {
            propId: "p-2",
            sportKey: "nba",
            playerName: "LeBron James",
            marketDisplay: "Points Over 25.5",
            line: 25.5,
            selection: "OVER",
            offeredDecimalOdds: 1.91,
          },
        ],
        quickpickUrl: "",
        placedAt: "2026-11-14T19:00:00Z",
        closingDecimalOdds: 1.9,
        closingFairProb: 0.524,
        clvPercentage: 0.002,
      },
      {
        betId: "ui-staged-uppercase",
        userId: "u-ui",
        sportsbook: "betmgm",
        decimalOdds: 2.1,
        americanOdds: 110,
        stakeAmount: 40,
        potentialPayout: 84,
        status: "STAGED" as any,
        legs: [
          {
            propId: "p-3",
            sportKey: "nfl",
            playerName: "Travis Kelce",
            marketDisplay: "Receiving Yards Over 65.5",
            line: 65.5,
            selection: "OVER",
            offeredDecimalOdds: 2.1,
          },
        ],
        quickpickUrl: "",
        stagedAt: "2026-11-14T17:00:00Z",
        closingDecimalOdds: 1.85,
        closingFairProb: 0.54,
        clvPercentage: 9.5,
      },
      {
        betId: "ui-out-of-bounds",
        userId: "u-ui",
        sportsbook: "caesars",
        decimalOdds: 2.0,
        americanOdds: 100,
        stakeAmount: 25,
        potentialPayout: 50,
        status: "pending",
        legs: [],
        quickpickUrl: "",
        placedAt: "2026-11-14T20:00:00Z",
        closingDecimalOdds: 12000,
        closingFairProb: 1.0,
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(BetTrackerDashboard, { initialBets: bets }),
    );

    expect(html).toContain("Edge Distribution · By Sportsbook");
    expect(html).toContain("DraftKings");
    expect(html).toContain("0.0% beat (0/1)");
    expect(html).toContain("FanDuel");
    expect(html).toContain("100.0% beat (1/1)");
    expect(html).toContain("Unweighted:");
    expect(html).toContain("Edge Verification Guard");
    expect(html).toContain("Close: -105 (1.95x)");
    expect(html).toContain("Fair Close: 51.3%");
    expect(html).toContain("0.0% CLV");
    expect(html).toContain("+0.002% CLV");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain("width:0%");

    // Uppercase STAGED slip CLV and closing benchmarks must not leak
    expect(html).not.toContain("+9.5% CLV");
    expect(html).not.toContain("(1.85x)");
    expect(html).not.toContain("Fair Close: 54.0%");

    // Out-of-bounds closing odds (>9999.9999) and prob (1.0) must not emit empty wrapper or crash
    expect(html).not.toContain("(12000.00x)");
  });

  it("interactive DOM test: clicking Won on a pending bet omits CLV fields when clvPercentage > 10.0", async () => {
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { BetTrackerDashboard } = await import("./BetTrackerDashboard");
    const { saveTrackedBet, TRACKED_BETS_STORAGE_KEY } = await import("@/lib/ledger");

    const { mockDoc, storage, createMockNode } = createMockDomEnv();
    const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    const prevStorage = (globalThis as any).localStorage;
    const prevFetch = (globalThis as any).fetch;

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).document = mockDoc;
    (globalThis as any).window = mockDoc.defaultView;
    (globalThis as any).localStorage = storage;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    (globalThis as any).fetch = fetchMock;

    const pendingSuspectBet: TrackedBet = {
      betId: "b-interactive-suspect-clv",
      userId: "",
      sportsbook: "fanduel",
      decimalOdds: 2.0,
      americanOdds: 100,
      stakeAmount: 50,
      potentialPayout: 100,
      status: "pending",
      legs: [
        {
          propId: "prop-int-1",
          sportKey: "nfl",
          playerName: "Patrick Mahomes",
          marketDisplay: "Pass Yards Over 275.5",
          line: 275.5,
          selection: "OVER",
          offeredDecimalOdds: 2.0,
        },
      ],
      quickpickUrl: "",
      placedAt: "2026-11-14T20:00:00Z",
      closingDecimalOdds: 1.75,
      closingFairProb: 0.57,
      clvPercentage: 14.0,
    };
    saveTrackedBet(pendingSuspectBet);

    const container = createMockNode(1, "DIV");
    container.ownerDocument = mockDoc;
    const root = createRoot(container as any);

    try {
      await act(async () => {
        root.render(
          React.createElement(BetTrackerDashboard, {
            initialBets: [pendingSuspectBet],
          }),
        );
      });

      const getText = (node: any): string => {
        if (!node) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(getText).join(" ");
        if (typeof node === "object" && node.props?.children) {
          return getText(node.props.children);
        }
        return "";
      };

      const findButtonOnClick = (node: any, label: string): any => {
        const propsKey = Object.keys(node).find((k) =>
          k.startsWith("__reactProps$"),
        );
        if (propsKey) {
          const props = node[propsKey];
          if (node.tagName === "BUTTON" && typeof props?.onClick === "function") {
            if (getText(props.children).trim() === label) {
              return props.onClick;
            }
          }
        }
        for (const child of node.childNodes || []) {
          const found = findButtonOnClick(child, label);
          if (found) return found;
        }
        return null;
      };

      const wonClick = findButtonOnClick(container, "Won");
      expect(typeof wonClick).toBe("function");

      await act(async () => {
        wonClick();
      });

      const patchCalls = fetchMock.mock.calls.filter(
        (call: any[]) =>
          call[0] === "/api/bets/b-interactive-suspect-clv" &&
          call[1]?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
      const [, patchInit] = patchCalls[0];
      const sentBody = JSON.parse(String(patchInit.body));
      expect(sentBody.status).toBe("won");
      expect(typeof sentBody.userId).toBe("string");
      expect(sentBody.userId.length).toBeGreaterThan(0);
      expect((patchInit.headers as Record<string, string>)["x-user-id"]).toBe(
        sentBody.userId,
      );
      expect(sentBody.clvPercentage).toBeUndefined();
      expect(sentBody.closingDecimalOdds).toBeUndefined();
      expect(sentBody.closingFairProb).toBeUndefined();

      const storedAfter = JSON.parse(
        storage.getItem(TRACKED_BETS_STORAGE_KEY) || "[]",
      );
      expect(storedAfter[0].status).toBe("won");
    } finally {
      await act(async () => {
        root.unmount();
      });
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
      (globalThis as any).localStorage = prevStorage;
      (globalThis as any).fetch = prevFetch;
    }
  });
});
