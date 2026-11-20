import type { WeatherBadge } from "./preset";

export type SportFilter = "all" | "nfl" | "nba";
export type DateWindow = "today" | "tomorrow" | "weekend";
export type DateWindowFilter = "all" | DateWindow;

export type NflMarketKey =
  | "player_anytime_td"
  | "player_pass_yds"
  | "player_rush_yds";

export type NbaMarketKey =
  | "player_points"
  | "player_rebounds"
  | "player_threes";

export type MarketKey = NflMarketKey | NbaMarketKey;
export type MarketFilter = "all" | MarketKey;

export type ValueTier = "STANDARD" | "POSITIVE_VALUE" | "HIGH_VALUE";

export interface MarketPropRow {
  propId: string;
  eventId: string;
  sportKey: "nfl" | "nba";
  playerName: string;
  teamAbbreviation: string;
  matchup: string;
  commenceTime: string;
  dateWindow: DateWindow;
  marketKey: MarketKey | string;
  marketLabel: string;
  marketDisplay: string;
  selection: "OVER" | "UNDER";
  lineValue?: number | null;
  offeredDecimalOdds: string;
  offeredAmericanOdds: number;
  sharpDecimalOdds?: string | null;
  sharpAmericanOdds?: number | null;
  fairProbability: string;
  guardedEv: string;
  hitRateL5?: string | null;
  hitRateL10?: string | null;
  hitRateSeason?: string | null;
  hitRateDisplay: string | null;
  sofascoreForm: boolean[];
  sofascoreDots: string;
  weatherBadge?: WeatherBadge | null;
  hybridValueScore: number;
  status: "ACTIVE";
  valueTier: ValueTier;
  isHighValue: boolean;
}

/** One side of a main line. `point` is null for moneyline; 0 is a real pick'em. */
export interface LinePrice {
  point: number | null;
  decimalOdds: string;
  americanOdds: number;
}

export interface HomeAwayLines {
  home: LinePrice | null;
  away: LinePrice | null;
}

export interface TotalLines {
  over: LinePrice | null;
  under: LinePrice | null;
}

/** Consensus main lines; a market without data is null (never defaulted). */
export interface GameLines {
  spread: HomeAwayLines | null;
  moneyline: HomeAwayLines | null;
  total: TotalLines | null;
}

export interface ScheduledEventSummary {
  eventId: string;
  sportKey: "nfl" | "nba";
  matchup: string;
  homeTeamAbbreviation: string;
  awayTeamAbbreviation: string;
  commenceTime: string;
  dateWindow: DateWindow;
  propCount: number;
  topHybridValueScore: number;
  lines?: GameLines;
}

export interface MarketBrowserFeed {
  generatedAt: string;
  sportKey: string;
  props: MarketPropRow[];
  games: ScheduledEventSummary[];
  /** "sample" when fixtures are served behind the dev flag. */
  reason?: "live" | "feed_unavailable" | "sample";
}
