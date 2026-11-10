export interface BetLeg {
  propId: string;
  playerName: string;
  marketDisplay: string;
  line?: number | null;
  selection: string;
  offeredDecimalOdds: number | string;
  eventId?: string;
  sportKey?: string;
  teamAbbreviation?: string;
  marketKey?: string;
  offeredAmericanOdds?: number;
  guardedEv?: number | string;
}

export interface StagedBet {
  betId: string;
  userId: string;
  sportsbook: string;
  decimalOdds: number;
  americanOdds: number;
  combinedDecimalOdds?: number;
  combinedAmericanOdds?: number;
  stakeAmount: number;
  stake?: number;
  potentialPayout: number;
  status: "staged";
  legs: BetLeg[];
  quickpickUrl: string;
  stagedAt: string; // ISO 8601 UTC
}

export interface StageBetRequest {
  betId?: string;
  userId?: string;
  sportsbook: string;
  decimalOdds?: number;
  combinedDecimalOdds?: number;
  americanOdds?: number;
  combinedAmericanOdds?: number;
  stakeAmount?: number;
  stake?: number;
  potentialPayout?: number;
  legs: BetLeg[];
  quickpickUrl?: string;
}

export interface StageBetResponse {
  success: boolean;
  bet: StagedBet;
  // Also expose top-level properties of StagedBet for seamless destructuring
  betId: string;
  userId: string;
  sportsbook: string;
  decimalOdds: number;
  americanOdds: number;
  combinedDecimalOdds?: number;
  combinedAmericanOdds?: number;
  stakeAmount: number;
  potentialPayout: number;
  status: "staged";
  legs: BetLeg[];
  quickpickUrl: string;
  stagedAt: string;
}

export type StageBetErrorCode =
  | "EMPTY_PARLAY_LEGS"
  | "INVALID_LEG_DATA"
  | "INVALID_ODDS"
  | "SUSPECT_STALE_LINE"
  | "MISSING_REQUIRED_FIELDS"
  | "INTERNAL_ERROR";

export interface StageBetErrorResponse {
  error: {
    code: StageBetErrorCode | string;
    message: string;
  };
}
