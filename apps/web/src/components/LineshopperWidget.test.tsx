import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import type { SportsbookId } from "@/types/lineshopper";
import { compareMultiBookOdds } from "@/lib/lineshopper";
import { LineshopperWidget } from "./LineshopperWidget";

function createMockLeg(
  propId: string,
  playerName: string,
  quotes?: Partial<Record<SportsbookId, { decimalOdds: number; isAvailable?: boolean }>>,
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

describe("LineshopperWidget", () => {
  it("renders 4 sportsbooks, highlights Best Value Book in emerald, and displays odds in JetBrains Mono font-telemetry", () => {
    const leg1 = createMockLeg("leg-1", "Derrick Henry", {
      fanduel: { decimalOdds: 2.08 },
      draftkings: { decimalOdds: 2.00 },
      betmgm: { decimalOdds: 2.00 },
      caesars: { decimalOdds: 2.00 },
    });
    const leg2 = createMockLeg("leg-2", "Amon-Ra St. Brown", {
      fanduel: { decimalOdds: 2.50 },
      draftkings: { decimalOdds: 2.35 },
      betmgm: { decimalOdds: 2.45 },
      caesars: { decimalOdds: 2.25 },
    });

    const legs = [leg1, leg2];
    const comparison = compareMultiBookOdds(legs, { selectedSportsbook: "fanduel" });

    const html = renderToStaticMarkup(
      <LineshopperWidget
        legs={legs}
        comparison={comparison}
        selectedSportsbook="fanduel"
        onSelectSportsbook={() => {}}
      />,
    );

    // Verify integrated books are present
    expect(html).toContain("FanDuel");
    expect(html).toContain("DraftKings");
    expect(html).toContain("BetMGM");
    expect(html).toContain("Caesars");
    expect(html).toContain("Fanatics");
    expect(html).toContain("Sleeper");

    // Verify Best Value badge & odds
    expect(html).toContain("Best Value");
    expect(html).toContain("+420");
    expect(html).toContain("+370");

    // Verify font-telemetry (JetBrains Mono)
    expect(html).toContain("font-telemetry");

    // Verify edge indication
    expect(html).toContain("Edge");

    // Verify selected cyan ring on FanDuel
    expect(html).toContain("ring-accent-cyan");
  });

  it("renders Unavailable status with missing leg count when a bookmaker lacks lines for a leg", () => {
    const leg1 = createMockLeg("leg-1", "Derrick Henry", {
      fanduel: { decimalOdds: 2.0 },
      draftkings: { decimalOdds: 2.0 },
      betmgm: { decimalOdds: 2.0 },
      caesars: { decimalOdds: 2.0 },
    });
    const leg2 = createMockLeg("leg-2", "Lamar Jackson", {
      fanduel: { decimalOdds: 1.8 },
      draftkings: { decimalOdds: 1.8 },
      betmgm: { decimalOdds: 1.8 },
      caesars: { decimalOdds: 0, isAvailable: false },
    });

    const legs = [leg1, leg2];
    const comparison = compareMultiBookOdds(legs);

    const html = renderToStaticMarkup(
      <LineshopperWidget
        legs={legs}
        comparison={comparison}
        selectedSportsbook="fanduel"
        onSelectSportsbook={() => {}}
      />,
    );

    expect(html).toContain("Unavailable (1 missing)");
  });

  it("does not render edge badge when dollar edge rounds to less than $1", () => {
    const leg1 = createMockLeg("leg-1", "Derrick Henry", {
      fanduel: { decimalOdds: 2.005 },
      draftkings: { decimalOdds: 2.0 },
      betmgm: { decimalOdds: 2.0 },
      caesars: { decimalOdds: 2.0 },
    });
    const leg2 = createMockLeg("leg-2", "Lamar Jackson", {
      fanduel: { decimalOdds: 2.0 },
      draftkings: { decimalOdds: 2.0 },
      betmgm: { decimalOdds: 2.0 },
      caesars: { decimalOdds: 2.0 },
    });

    const legs = [leg1, leg2];
    const comparison = compareMultiBookOdds(legs);

    const html = renderToStaticMarkup(
      <LineshopperWidget
        legs={legs}
        comparison={comparison}
        selectedSportsbook="fanduel"
        onSelectSportsbook={() => {}}
      />,
    );

    expect(html).not.toContain("+0 Edge");
    expect(html).not.toContain("+$0 Edge");
  });

  it("renders prompt state when slip has 0 legs", () => {
    const comparison = compareMultiBookOdds([]);

    const html = renderToStaticMarkup(
      <LineshopperWidget
        legs={[]}
        comparison={comparison}
        selectedSportsbook="fanduel"
        onSelectSportsbook={() => {}}
      />,
    );

    expect(html).toContain("Add 2+ legs to compare parlay lines across sportsbooks");
  });

  it("handles 1-leg slip state without parlay multiplier label and without Best Value badge", () => {
    const singleLeg = createMockLeg("leg-1", "Derrick Henry", {
      fanduel: { decimalOdds: 1.95 },
      draftkings: { decimalOdds: 1.90 },
      betmgm: { decimalOdds: 1.85 },
      caesars: { decimalOdds: 1.80 },
    });

    const legs = [singleLeg];
    const comparison = compareMultiBookOdds(legs);

    const html = renderToStaticMarkup(
      <LineshopperWidget
        legs={legs}
        comparison={comparison}
        selectedSportsbook="fanduel"
        onSelectSportsbook={() => {}}
      />,
    );

    expect(html).toContain("FanDuel");
    expect(html).toContain("Single Prop Line");
    expect(html).not.toContain("Combined Parlay Multiplier");
    expect(html).not.toContain("Best Value ⭐");
  });

  describe("User Interactions", () => {
    it("calls onSelectSportsbook when clicking an available sportsbook card", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 2.0 },
      });
      const leg2 = createMockLeg("leg-2", "Amon-Ra St. Brown", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 2.0 },
      });

      const onSelect = vi.fn();
      const tree = LineshopperWidget({
        legs: [leg1, leg2],
        selectedSportsbook: "fanduel",
        onSelectSportsbook: onSelect,
      });

      // Find cards in radiogroup
      const children = React.Children.toArray(tree.props.children);
      const radioGroup = children.find(
        (c: any) => c?.props?.role === "radiogroup",
      ) as React.ReactElement<any>;
      expect(radioGroup).toBeDefined();

      const cards = React.Children.toArray(radioGroup.props.children) as React.ReactElement<any>[];
      const dkCard = cards.find((c) => c.key === "draftkings" || c.key === ".$draftkings");
      expect(dkCard).toBeDefined();

      // Click DraftKings card
      dkCard!.props.onClick();
      expect(onSelect).toHaveBeenCalledWith("draftkings");

      // KeyDown Enter on DraftKings card
      onSelect.mockClear();
      const preventDefault = vi.fn();
      dkCard!.props.onKeyDown({ key: "Enter", preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledWith("draftkings");
    });

    it("does not call onSelectSportsbook when clicking an unavailable sportsbook card", () => {
      const leg1 = createMockLeg("leg-1", "Derrick Henry", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 0, isAvailable: false },
      });
      const leg2 = createMockLeg("leg-2", "Amon-Ra St. Brown", {
        fanduel: { decimalOdds: 2.0 },
        draftkings: { decimalOdds: 2.0 },
        betmgm: { decimalOdds: 2.0 },
        caesars: { decimalOdds: 0, isAvailable: false },
      });

      const onSelect = vi.fn();
      const tree = LineshopperWidget({
        legs: [leg1, leg2],
        selectedSportsbook: "fanduel",
        onSelectSportsbook: onSelect,
      });

      const children = React.Children.toArray(tree.props.children);
      const radioGroup = children.find(
        (c: any) => c?.props?.role === "radiogroup",
      ) as React.ReactElement<any>;
      const cards = React.Children.toArray(radioGroup.props.children) as React.ReactElement<any>[];
      const czCard = cards.find((c) => c.key === "caesars" || c.key === ".$caesars");
      expect(czCard).toBeDefined();

      // Click Caesars (unavailable)
      czCard!.props.onClick();
      expect(onSelect).not.toHaveBeenCalled();

      // KeyDown on Caesars
      const preventDefault = vi.fn();
      czCard!.props.onKeyDown({ key: "Enter", preventDefault });
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
