export interface WeatherBadge {
  badgeType: "CLEAR" | "WIND_WARNING" | "PRECIP_WARNING" | "FREEZING_WARNING" | "DOME";
  summary: string;
  isThreat: boolean;
}

export interface PresetLeg {
  propId: string;
  eventId: string;
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
  hitRateDisplay: string;
  sofascoreForm: boolean[];
  sofascoreDots: string;
  weatherBadge?: WeatherBadge | null;
  convictionRationale: string;
}

export interface PresetCard {
  presetId: string;
  title: string;
  sportKey: "nfl" | "nba";
  themeBadge: string;
  legs: PresetLeg[];
  combinedDecimalOdds: string;
  combinedAmericanOdds: number;
  combinedFairProbability: string;
  combinedEv: string;
  hybridValueScore: number;
  status: "ACTIVE" | "COMMENCED" | "SETTLED";
  commenceTime: string;
}

export interface CuratedPresetFeed {
  generatedAt: string;
  cards: PresetCard[];
}

export interface OddsDeltaFrame {
  eventId: string;
  sportKey: string;
  marketKey: string;
  playerName?: string;
  decimalOdds: string;
  americanOdds: number;
  timestamp: string;
}
