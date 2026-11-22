import type {
  DateWindowFilter,
  LinePrice,
  MarketFilter,
  MarketPropRow,
  SportFilter,
} from "@/types/market";
import { computeHybridValueScore, decimalToAmerican } from "@/lib/math";

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
    eventId?: string | null;
  },
): MarketPropRow[] {
  let result = [...props];

  if (filters.eventId) {
    const eventId = filters.eventId;
    result = result.filter((p) => p.eventId === eventId);
  }

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

/** Props for the selected market tab; "all" keeps everything. */
export function filterByTab(props: MarketPropRow[], tab: string): MarketPropRow[] {
  return tab === "all" ? props : props.filter((p) => p.marketKey === tab);
}

/** Market tabs for a game's props: only markets present, canonical order, labelled. */
export function marketTabs(props: MarketPropRow[]): { key: string; label: string }[] {
  const present = new Set(props.map((p) => p.marketKey));
  const tabs: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const sport of ["nfl", "nba"] as const) {
    for (const [key, label] of Object.entries(CANONICAL_MARKETS_BY_SPORT[sport])) {
      if (present.has(key)) {
        tabs.push({ key, label });
        seen.add(key);
      }
    }
  }
  for (const p of props) {
    if (!seen.has(p.marketKey)) {
      seen.add(p.marketKey);
      tabs.push({ key: p.marketKey, label: p.marketLabel || p.marketKey });
    }
  }
  return tabs;
}

const MISSING = "—";

export function formatAmerican(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** Spread cell: "+3.5 -110", pick'em "PK -110", missing "—". */
export function formatSpread(price: LinePrice | null | undefined): string {
  if (!price || price.point === null) {
    return MISSING;
  }
  const point =
    price.point === 0
      ? "PK"
      : price.point > 0
        ? `+${price.point}`
        : `${price.point}`;
  return `${point} ${formatAmerican(price.americanOdds)}`;
}

/** Moneyline cell: "+140", missing "—". */
export function formatMoney(price: LinePrice | null | undefined): string {
  if (!price) {
    return MISSING;
  }
  return formatAmerican(price.americanOdds);
}

/** Total cell: "O 45.5 -110", missing "—". */
export function formatTotal(
  price: LinePrice | null | undefined,
  side: "O" | "U",
): string {
  if (!price || price.point === null) {
    return MISSING;
  }
  return `${side} ${price.point} ${formatAmerican(price.americanOdds)}`;
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

  const newScore = computeHybridValueScore([prop], newEv);
  const l10 =
    prop.hitRateL10 === null || prop.hitRateL10 === undefined || prop.hitRateL10 === ""
      ? NaN
      : Number(prop.hitRateL10);

  // Enforce Outlier Guard (EV <= 10.0%) during live SSE recalculations
  const isOutlier = newEv > 0.10;
  const isHighVal = !isOutlier && newEv >= 0.035 && Number.isFinite(l10) && l10 >= 0.7;
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
