import type { DateWindow, MarketPropRow, ValueTier } from "./market";
import type { WeatherBadge } from "./preset";

export interface ParlayLeg {
  propId: string;
  eventId: string;
  sportKey: "nfl" | "nba";
  playerName: string;
  teamAbbreviation: string;
  matchup: string;
  marketKey: string;
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
  hitRateDisplay?: string;
  sofascoreForm?: boolean[];
  sofascoreDots?: string;
  weatherBadge?: WeatherBadge | null;
  hybridValueScore?: number;
  convictionRationale?: string;
  dateWindow?: DateWindow;
  valueTier?: ValueTier;
  isHighValue?: boolean;
}

export interface ParlaySlip {
  legs: ParlayLeg[];
  combinedDecimalOdds: string;
  combinedAmericanOdds: number;
  combinedFairProbability: string;
  combinedEv: string;
  hybridValueScore: number;
  isValidParlay: boolean;
  isSameGameParlay: boolean;
  correlationAudit?: string[];
}

export interface ParlayDrawerState {
  isOpen: boolean;
  isDocked: boolean;
  slip: ParlaySlip;
  swappedLegPropId: string | null;
}

export interface SwapModalState {
  isOpen: boolean;
  targetLeg: ParlayLeg | null;
}
