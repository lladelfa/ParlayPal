export type BetStatus =
  | "staged"
  | "pending"
  | "won"
  | "lost"
  | "void"
  | "settled_won"
  | "settled_lost"
  | "push";

export const VALID_BET_STATUSES: readonly BetStatus[] = [
  "staged",
  "pending",
  "won",
  "lost",
  "void",
  "settled_won",
  "settled_lost",
  "push",
] as const;

export type BetFilterStatus = "all" | "staged" | "pending" | "won" | "lost";

export interface LiveGameProgress {
  status: "scheduled" | "in_progress" | "final" | "postponed";
  period?: string; // e.g. "Q3 4:12"
  scoreDisplay?: string; // e.g. "BAL 21, PIT 14"
  homeScore?: number;
  awayScore?: number;
  commenceTime?: string; // e.g. "Sun 1:00 PM"
  displayClock?: string;
}

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
  liveProgress?: LiveGameProgress;
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

export interface TrackedBet {
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
  status: BetStatus;
  legs: BetLeg[];
  placedAt?: string;
  stagedAt?: string;
  settledAt?: string | null;
  quickpickUrl?: string;
  closingDecimalOdds?: number | null;
  closingFairProb?: number | null;
  clvPercentage?: number | null;
  liveProgress?: LiveGameProgress;
}

export interface BetSummaryMetrics {
  totalBets: number;
  stagedCount: number;
  pendingCount: number;
  wonCount: number;
  lostCount: number;
  activeAction: number;
  totalStaked: number;
  totalSettledStaked: number;
  totalReturn: number;
  netProfit: number;
  roi: number;
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
