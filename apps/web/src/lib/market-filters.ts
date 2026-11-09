import type { MarketPropRow, SportFilter, DateWindowFilter, MarketFilter } from "@/types/market";
import { decimalToAmerican } from "@/lib/math";

export const CANONICAL_MARKETS_BY_SPORT: Record<"nfl" | "nba", Record<string, string>> = {
  nfl: {
    player_anytime_td: "Anytime TD",
    player_pass_yds: "Passing Yards",
    player_rush_yds: "Rushing Yards",
  },
  nba: {
    player_points: "Points",
    player_rebounds: "Rebounds",
    player_threes: "Threes",
  },
};

export function filterMarketProps(
  props: MarketPropRow[],
  filters: {
    sport?: SportFilter;
    dateWindow?: DateWindowFilter;
    market?: MarketFilter;
    query?: string;
  },
): MarketPropRow[] {
  let result = [...props];

  const sport = filters.sport ?? "all";
  if (sport !== "all") {
    result = result.filter((p) => p.sportKey === sport);
  }

  const dateWindow = filters.dateWindow ?? "all";
  if (dateWindow !== "all") {
    result = result.filter((p) => p.dateWindow === dateWindow);
  }

  const market = filters.market ?? "all";
  if (market !== "all") {
    if (sport !== "all") {
      const validForSport = CANONICAL_MARKETS_BY_SPORT[sport];
      if (validForSport && market in validForSport) {
        result = result.filter((p) => p.marketKey === market);
      }
    } else {
      result = result.filter((p) => p.marketKey === market);
    }
  }

  if (filters.query && filters.query.trim()) {
    const q = filters.query.trim().toLowerCase();
    result = result.filter(
      (p) =>
        p.playerName.toLowerCase().includes(q) ||
        p.teamAbbreviation.toLowerCase().includes(q) ||
        p.matchup.toLowerCase().includes(q) ||
        p.marketLabel.toLowerCase().includes(q),
    );
  }

  return result;
}

export function recalculateMarketPropRow(
  prop: MarketPropRow,
  newDecimalOdds: number,
): MarketPropRow {
  if (!Number.isFinite(newDecimalOdds) || newDecimalOdds < 1.01) {
    return prop;
  }

  const decOddsStr = newDecimalOdds.toFixed(4);
  const americanOdds = decimalToAmerican(newDecimalOdds);

  const fairProb = parseFloat(prop.fairProbability);
  const newEv = fairProb * newDecimalOdds - 1.0;
  const newEvStr = newEv.toFixed(5);

  const l10 = prop.hitRateL10 ? parseFloat(prop.hitRateL10) : 0.7;
  const hitPct = l10 * 100.0;
  const evComp = Math.max(0.0, Math.min(100.0, newEv * 100.0 * 10.0 + 50.0));
  const newScore = Math.max(0, Math.min(100, Math.round(0.6 * hitPct + 0.4 * evComp)));

  // Enforce Outlier Guard (EV <= 10.0%) during live SSE recalculations
  const isOutlier = newEv > 0.10;
  const isHighVal = !isOutlier && newEv >= 0.035 && l10 >= 0.7;
  const tier: "STANDARD" | "POSITIVE_VALUE" | "HIGH_VALUE" = isHighVal
    ? "HIGH_VALUE"
    : !isOutlier && newEv >= 0.015
      ? "POSITIVE_VALUE"
      : "STANDARD";

  return {
    ...prop,
    offeredDecimalOdds: decOddsStr,
    offeredAmericanOdds: americanOdds,
    guardedEv: newEvStr,
    hybridValueScore: newScore,
    isHighValue: isHighVal,
    valueTier: tier,
  };
}
