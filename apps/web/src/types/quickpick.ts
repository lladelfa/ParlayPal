import type { SportsbookId } from "./lineshopper";
import type { ParlayLeg } from "./parlay";

export type QuickPickSelection = "OVER" | "UNDER" | "YES" | (string & {});

export interface QuickPickLeg {
  eventId: string;
  propId: string;
  playerName: string;
  marketType: string;
  marketKey?: string;
  selection: QuickPickSelection;
  lineValue: number | null;
  odds: string;
  americanOdds?: number;
  sportKey?: string;
  teamAbbreviation?: string;
  matchup?: string;
}

export interface QuickPickPayload {
  version: string;
  generator: string;
  sportsbook: SportsbookId;
  legs: QuickPickLeg[];
  stake?: number;
  totalOdds?: string;
  totalAmericanOdds?: number;
  createdAt: string;
}

export interface QuickPickLegInput {
  propId: string;
  eventId?: string;
  sportKey?: string;
  playerName: string;
  teamAbbreviation?: string;
  matchup?: string;
  marketKey?: string;
  marketType?: string;
  selection: "OVER" | "UNDER" | "YES" | string;
  lineValue?: number | null;
  offeredDecimalOdds?: string | number;
  offeredAmericanOdds?: number;
  odds?: string | number;
  guardedEv?: string | number;
  status?: string;
  isSuspectStaleLine?: boolean;
  sportsbookQuotes?: ParlayLeg["sportsbookQuotes"];
}

export interface QuickPickSerializeRequest {
  legs: (ParlayLeg | QuickPickLegInput)[];
  sportsbook: SportsbookId | string;
  stake?: number;
}

export interface QuickPickSerializeResponse {
  url: string;
  universalLink: string;
  deepLink: string;
  fallbackUrl: string;
  encodedData: string;
  payload: QuickPickPayload;
  executionLatencyMs?: number;
}

export type QuickPickErrorCode =
  | "EMPTY_PARLAY_LEGS"
  | "UNSUPPORTED_SPORTSBOOK"
  | "MAX_LEGS_EXCEEDED"
  | "INVALID_LEG_DATA"
  | "SUSPECT_STALE_LINE"
  | "INTERNAL_ERROR";

export interface QuickPickErrorResponse {
  error: {
    code: QuickPickErrorCode;
    message: string;
  };
}
