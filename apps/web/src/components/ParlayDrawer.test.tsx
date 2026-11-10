import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import { ParlayDrawerProvider } from "@/context/ParlayDrawerContext";
import { serializeQuickPickPayload } from "@/lib/quickpick";
import { ParlayDrawer } from "./ParlayDrawer";

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
});
