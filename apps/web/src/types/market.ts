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
  hitRateDisplay: string;
  sofascoreForm: boolean[];
  sofascoreDots: string;
  weatherBadge?: WeatherBadge | null;
  hybridValueScore: number;
  status: "ACTIVE";
  valueTier: ValueTier;
  isHighValue: boolean;
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
}

export interface MarketBrowserFeed {
  generatedAt: string;
  sportKey: string;
  props: MarketPropRow[];
  games: ScheduledEventSummary[];
}
