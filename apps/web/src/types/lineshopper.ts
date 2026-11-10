export type SportsbookId =
  | "fanduel"
  | "draftkings"
  | "betmgm"
  | "caesars"
  | "fanatics"
  | "sleeper";

export interface SportsbookMeta {
  id: SportsbookId;
  name: string;
  shortName: string;
  brandColor: string;
  accentColor: string;
}

export const SPORTSBOOK_REGISTRY: Record<SportsbookId, SportsbookMeta> = {
  fanduel: {
    id: "fanduel",
    name: "FanDuel",
    shortName: "FD",
    brandColor: "#14805e",
    accentColor: "#2797ff",
  },
  draftkings: {
    id: "draftkings",
    name: "DraftKings",
    shortName: "DK",
    brandColor: "#539f37",
    accentColor: "#539f37",
  },
  betmgm: {
    id: "betmgm",
    name: "BetMGM",
    shortName: "MG",
    brandColor: "#c4a265",
    accentColor: "#c4a265",
  },
  caesars: {
    id: "caesars",
    name: "Caesars",
    shortName: "CZ",
    brandColor: "#0c2340",
    accentColor: "#caa150",
  },
  fanatics: {
    id: "fanatics",
    name: "Fanatics",
    shortName: "FN",
    brandColor: "#111111",
    accentColor: "#f01d36",
  },
  sleeper: {
    id: "sleeper",
    name: "Sleeper",
    shortName: "SL",
    brandColor: "#0f1f2e",
    accentColor: "#00c3a5",
  },
};

export const INTEGRATED_SPORTSBOOKS: readonly SportsbookId[] = [
  "fanduel",
  "draftkings",
  "betmgm",
  "caesars",
  "fanatics",
  "sleeper",
] as const;

export interface SportsbookQuote {
  sportsbook: SportsbookId;
  sportsbookId: SportsbookId;
  decimalOdds?: number | string | null;
  americanOdds?: number | null;
  isAvailable: boolean;
}

export interface BookmakerParlayPricing {
  sportsbookId: SportsbookId;
  name: string;
  shortName: string;
  brandColor: string;
  accentColor: string;
  isAvailable: boolean;
  missingLegCount: number;
  combinedDecimalOdds: number;
  combinedAmericanOdds: number;
  formattedAmericanOdds: string;
  isBestValue: boolean;
  isSelected?: boolean;
  payoutOnReferenceStake: number;
  profitOnReferenceStake: number;
}

export interface LineshopperComparisonResult {
  bookmakers: Record<SportsbookId, BookmakerParlayPricing>;
  bookmakerList: BookmakerParlayPricing[];
  bestValueBookId: SportsbookId | null;
  runnerUpBookId: SportsbookId | null;
  bestDecimalOdds: number | null;
  bestAmericanOdds: number | null;
  runnerUpDecimalOdds: number | null;
  runnerUpAmericanOdds: number | null;
  dollarEdge: number;
  edgeDescription: string;
  hasComparison: boolean;
  referenceStake: number;
  totalLegs: number;
  hasMissingLines: boolean;
}
