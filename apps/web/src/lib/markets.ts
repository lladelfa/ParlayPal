import type {
  MarketBrowserFeed,
  MarketPropRow,
  ScheduledEventSummary,
  ValueTier,
} from "@/types/market";
import { createRedisClient, marketsBrowserKey } from "@/lib/redis";
import { sampleDataEnabled } from "@/lib/presets";
import {
  CANONICAL_MARKETS_BY_SPORT,
  filterMarketProps,
  recalculateMarketPropRow,
} from "./market-filters";
import {
  coerceNullableNumber,
  coerceNullableString,
  coerceNumber,
  coerceString,
  normalizeWeatherBadge,
} from "./presets";

export {
  CANONICAL_MARKETS_BY_SPORT,
  filterMarketProps,
  recalculateMarketPropRow,
};

type JsonRecord = Record<string, unknown>;

function pickField(obj: JsonRecord, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

function normalizeMarketPropRow(raw: unknown): MarketPropRow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  const propId = coerceString(pickField(obj, "propId", "prop_id"));
  const eventId = coerceString(pickField(obj, "eventId", "event_id"));
  const playerName = coerceString(pickField(obj, "playerName", "player_name"));
  if (!propId || !eventId || !playerName) {
    return null;
  }
  const rawSport = coerceString(
    pickField(obj, "sportKey", "sport_key"),
    "nfl",
  ).toLowerCase();
  const rawSel = coerceString(obj.selection, "OVER").toUpperCase();
  const rawForm = pickField(obj, "sofascoreForm", "sofascore_form");
  const rawWindow = coerceString(
    pickField(obj, "dateWindow", "date_window"),
    "today",
  );
  const dateWindow =
    rawWindow === "tomorrow" || rawWindow === "weekend" ? rawWindow : "today";
  const valueTier = coerceString(
    pickField(obj, "valueTier", "value_tier"),
    "POSITIVE_VALUE",
  ) as ValueTier;

  return {
    propId,
    eventId,
    sportKey: rawSport.includes("nba") ? "nba" : "nfl",
    playerName,
    teamAbbreviation: coerceString(
      pickField(obj, "teamAbbreviation", "team_abbreviation"),
      "TBD",
    ),
    matchup: coerceString(obj.matchup),
    commenceTime: coerceString(
      pickField(obj, "commenceTime", "commence_time"),
      new Date().toISOString(),
    ),
    dateWindow,
    marketKey: coerceString(pickField(obj, "marketKey", "market_key")),
    marketLabel: coerceString(pickField(obj, "marketLabel", "market_label")),
    marketDisplay: coerceString(pickField(obj, "marketDisplay", "market_display")),
    selection: rawSel === "UNDER" ? "UNDER" : "OVER",
    lineValue: coerceNullableNumber(pickField(obj, "lineValue", "line_value")),
    offeredDecimalOdds: coerceString(
      pickField(obj, "offeredDecimalOdds", "offered_decimal_odds"),
      "1.9000",
    ),
    offeredAmericanOdds: coerceNumber(
      pickField(obj, "offeredAmericanOdds", "offered_american_odds"),
      -110,
    ),
    sharpDecimalOdds: coerceNullableString(
      pickField(obj, "sharpDecimalOdds", "sharp_decimal_odds"),
    ),
    sharpAmericanOdds: coerceNullableNumber(
      pickField(obj, "sharpAmericanOdds", "sharp_american_odds"),
    ),
    fairProbability: coerceString(
      pickField(obj, "fairProbability", "fair_probability"),
      "0.50000",
    ),
    guardedEv: coerceString(pickField(obj, "guardedEv", "guarded_ev"), "0.00000"),
    hitRateL5: coerceNullableString(pickField(obj, "hitRateL5", "hit_rate_l5")),
    hitRateL10: coerceNullableString(pickField(obj, "hitRateL10", "hit_rate_l10")),
    hitRateSeason: coerceNullableString(
      pickField(obj, "hitRateSeason", "hit_rate_season"),
    ),
    hitRateDisplay: coerceNullableString(
      pickField(obj, "hitRateDisplay", "hit_rate_display"),
    ),
    sofascoreForm: Array.isArray(rawForm) ? rawForm.map(Boolean) : [],
    sofascoreDots: coerceString(
      pickField(obj, "sofascoreDots", "sofascore_dots"),
      "",
    ),
    weatherBadge: normalizeWeatherBadge(
      pickField(obj, "weatherBadge", "weather_badge"),
    ),
    hybridValueScore: coerceNumber(
      pickField(obj, "hybridValueScore", "hybrid_value_score"),
      0,
    ),
    status: "ACTIVE",
    valueTier,
    isHighValue: Boolean(pickField(obj, "isHighValue", "is_high_value")),
  };
}

function normalizeGameSummary(raw: unknown): ScheduledEventSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  const eventId = coerceString(pickField(obj, "eventId", "event_id"));
  if (!eventId) {
    return null;
  }
  const rawSport = coerceString(
    pickField(obj, "sportKey", "sport_key"),
    "nfl",
  ).toLowerCase();
  const rawWindow = coerceString(
    pickField(obj, "dateWindow", "date_window"),
    "today",
  );
  return {
    eventId,
    sportKey: rawSport.includes("nba") ? "nba" : "nfl",
    matchup: coerceString(obj.matchup),
    homeTeamAbbreviation: coerceString(
      pickField(obj, "homeTeamAbbreviation", "home_team_abbreviation"),
    ),
    awayTeamAbbreviation: coerceString(
      pickField(obj, "awayTeamAbbreviation", "away_team_abbreviation"),
    ),
    commenceTime: coerceString(
      pickField(obj, "commenceTime", "commence_time"),
      new Date().toISOString(),
    ),
    dateWindow:
      rawWindow === "tomorrow" || rawWindow === "weekend" ? rawWindow : "today",
    propCount: coerceNumber(pickField(obj, "propCount", "prop_count"), 0),
    topHybridValueScore: coerceNumber(
      pickField(obj, "topHybridValueScore", "top_hybrid_value_score"),
      0,
    ),
  };
}

export function normalizeMarketBrowserFeed(raw: unknown): MarketBrowserFeed | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  if (!Array.isArray(obj.props)) {
    return null;
  }
  const props = obj.props
    .map(normalizeMarketPropRow)
    .filter((row): row is MarketPropRow => row !== null);
  const games = Array.isArray(obj.games)
    ? obj.games
        .map(normalizeGameSummary)
        .filter((game): game is ScheduledEventSummary => game !== null)
    : [];

  return {
    generatedAt: coerceString(
      pickField(obj, "generatedAt", "generated_at"),
      new Date().toISOString(),
    ),
    sportKey: coerceString(pickField(obj, "sportKey", "sport_key"), "all"),
    props,
    games,
  };
}

export const FALLBACK_MARKET_BROWSER_FEED: MarketBrowserFeed = {
  generatedAt: new Date().toISOString(),
  sportKey: "all",
  games: [
    {
      eventId: "e1111111-1111-1111-1111-111111111111",
      sportKey: "nba",
      matchup: "BOS @ NYK",
      homeTeamAbbreviation: "NYK",
      awayTeamAbbreviation: "BOS",
      commenceTime: new Date(Date.now() + 4 * 3600000).toISOString(),
      dateWindow: "today",
      propCount: 2,
      topHybridValueScore: 88,
    },
    {
      eventId: "e2222222-2222-2222-2222-222222222222",
      sportKey: "nfl",
      matchup: "BAL @ PIT",
      homeTeamAbbreviation: "PIT",
      awayTeamAbbreviation: "BAL",
      commenceTime: new Date(Date.now() + 26 * 3600000).toISOString(),
      dateWindow: "tomorrow",
      propCount: 2,
      topHybridValueScore: 89,
    },
    {
      eventId: "e3333333-3333-3333-3333-333333333333",
      sportKey: "nba",
      matchup: "GSW @ LAL",
      homeTeamAbbreviation: "LAL",
      awayTeamAbbreviation: "GSW",
      commenceTime: new Date(Date.now() + 52 * 3600000).toISOString(),
      dateWindow: "weekend",
      propCount: 1,
      topHybridValueScore: 91,
    },
    {
      eventId: "e4444444-4444-4444-4444-444444444444",
      sportKey: "nfl",
      matchup: "BUF @ NYJ",
      homeTeamAbbreviation: "NYJ",
      awayTeamAbbreviation: "BUF",
      commenceTime: new Date(Date.now() + 56 * 3600000).toISOString(),
      dateWindow: "weekend",
      propCount: 2,
      topHybridValueScore: 86,
    },
  ],
  props: [
    {
      propId: "p1111111-1111-1111-1111-111111111111",
      eventId: "e2222222-2222-2222-2222-222222222222",
      sportKey: "nfl",
      playerName: "Derrick Henry",
      teamAbbreviation: "BAL",
      matchup: "BAL @ PIT",
      commenceTime: new Date(Date.now() + 26 * 3600000).toISOString(),
      dateWindow: "tomorrow",
      marketKey: "player_anytime_td",
      marketLabel: "Anytime TD",
      marketDisplay: "Anytime Touchdown",
      selection: "OVER",
      lineValue: 0.5,
      offeredDecimalOdds: "1.8000",
      offeredAmericanOdds: -125,
      sharpDecimalOdds: "1.7500",
      sharpAmericanOdds: -133,
      fairProbability: "0.58000",
      guardedEv: "0.04400",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "CLEAR",
        summary: "Clear · 42°F",
        isThreat: false,
      },
      hybridValueScore: 89,
      status: "ACTIVE",
      valueTier: "HIGH_VALUE",
      isHighValue: true,
    },
    {
      propId: "p2222222-2222-2222-2222-222222222222",
      eventId: "e1111111-1111-1111-1111-111111111111",
      sportKey: "nba",
      playerName: "Jayson Tatum",
      teamAbbreviation: "BOS",
      matchup: "BOS @ NYK",
      commenceTime: new Date(Date.now() + 4 * 3600000).toISOString(),
      dateWindow: "today",
      marketKey: "player_points",
      marketLabel: "Points",
      marketDisplay: "Over 26.5 Points",
      selection: "OVER",
      lineValue: 26.5,
      offeredDecimalOdds: "1.9091",
      offeredAmericanOdds: -110,
      sharpDecimalOdds: "1.8500",
      sharpAmericanOdds: -118,
      fairProbability: "0.55000",
      guardedEv: "0.05000",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "DOME",
        summary: "DOME Indoor",
        isThreat: false,
      },
      hybridValueScore: 88,
      status: "ACTIVE",
      valueTier: "HIGH_VALUE",
      isHighValue: true,
    },
    {
      propId: "p3333333-3333-3333-3333-333333333333",
      eventId: "e1111111-1111-1111-1111-111111111111",
      sportKey: "nba",
      playerName: "Jalen Brunson",
      teamAbbreviation: "NYK",
      matchup: "BOS @ NYK",
      commenceTime: new Date(Date.now() + 4 * 3600000).toISOString(),
      dateWindow: "today",
      marketKey: "player_points",
      marketLabel: "Points",
      marketDisplay: "Over 25.5 Points",
      selection: "OVER",
      lineValue: 25.5,
      offeredDecimalOdds: "1.8696",
      offeredAmericanOdds: -115,
      sharpDecimalOdds: "1.8200",
      sharpAmericanOdds: -122,
      fairProbability: "0.54500",
      guardedEv: "0.01890",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "DOME",
        summary: "DOME Indoor",
        isThreat: false,
      },
      hybridValueScore: 78,
      status: "ACTIVE",
      valueTier: "POSITIVE_VALUE",
      isHighValue: false,
    },
    {
      propId: "p4444444-4444-4444-4444-444444444444",
      eventId: "e3333333-3333-3333-3333-333333333333",
      sportKey: "nba",
      playerName: "Stephen Curry",
      teamAbbreviation: "GSW",
      matchup: "GSW @ LAL",
      commenceTime: new Date(Date.now() + 52 * 3600000).toISOString(),
      dateWindow: "weekend",
      marketKey: "player_threes",
      marketLabel: "Threes",
      marketDisplay: "Over 4.5 Threes",
      selection: "OVER",
      lineValue: 4.5,
      offeredDecimalOdds: "2.0500",
      offeredAmericanOdds: 105,
      sharpDecimalOdds: "1.9500",
      sharpAmericanOdds: -105,
      fairProbability: "0.52000",
      guardedEv: "0.06600",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "DOME",
        summary: "DOME Indoor",
        isThreat: false,
      },
      hybridValueScore: 91,
      status: "ACTIVE",
      valueTier: "HIGH_VALUE",
      isHighValue: true,
    },
    {
      propId: "p5555555-5555-5555-5555-555555555555",
      eventId: "e4444444-4444-4444-4444-444444444444",
      sportKey: "nfl",
      playerName: "Josh Allen",
      teamAbbreviation: "BUF",
      matchup: "BUF @ NYJ",
      commenceTime: new Date(Date.now() + 56 * 3600000).toISOString(),
      dateWindow: "weekend",
      marketKey: "player_pass_yds",
      marketLabel: "Passing Yards",
      marketDisplay: "Over 235.5 Pass Yds",
      selection: "OVER",
      lineValue: 235.5,
      offeredDecimalOdds: "1.8700",
      offeredAmericanOdds: -115,
      sharpDecimalOdds: "1.8000",
      sharpAmericanOdds: -125,
      fairProbability: "0.55500",
      guardedEv: "0.03780",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "WIND_WARNING",
        summary: "⚠️ 18mph Wind",
        isThreat: true,
      },
      hybridValueScore: 86,
      status: "ACTIVE",
      valueTier: "HIGH_VALUE",
      isHighValue: true,
    },
    {
      propId: "p6666666-6666-6666-6666-666666666666",
      eventId: "e4444444-4444-4444-4444-444444444444",
      sportKey: "nfl",
      playerName: "James Cook",
      teamAbbreviation: "BUF",
      matchup: "BUF @ NYJ",
      commenceTime: new Date(Date.now() + 56 * 3600000).toISOString(),
      dateWindow: "weekend",
      marketKey: "player_rush_yds",
      marketLabel: "Rushing Yards",
      marketDisplay: "Over 64.5 Rush Yds",
      selection: "OVER",
      lineValue: 64.5,
      offeredDecimalOdds: "1.9000",
      offeredAmericanOdds: -111,
      sharpDecimalOdds: "1.8300",
      sharpAmericanOdds: -120,
      fairProbability: "0.54000",
      guardedEv: "0.02600",
      hitRateL5: null,
      hitRateL10: null,
      hitRateSeason: null,
      hitRateDisplay: null,
      sofascoreForm: [],
      sofascoreDots: "",
      weatherBadge: {
        badgeType: "WIND_WARNING",
        summary: "⚠️ 18mph Wind",
        isThreat: true,
      },
      hybridValueScore: 80,
      status: "ACTIVE",
      valueTier: "POSITIVE_VALUE",
      isHighValue: false,
    },
  ],
};

export async function getMarketBrowserFeed(sportKey?: string): Promise<MarketBrowserFeed> {
  let redis: ReturnType<typeof createRedisClient> | null = null;
  try {
    redis = createRedisClient();
    if (typeof redis.connect === "function") {
      await redis.connect();
    }
    const key = marketsBrowserKey(sportKey);
    const snapshotKey = key.replace("markets:browser:", "markets:browser:snapshot:");
    const cached = (await redis.get(key)) ?? (await redis.get(snapshotKey));

    if (cached) {
      const normalized = normalizeMarketBrowserFeed(JSON.parse(cached));
      if (normalized && Array.isArray(normalized.props)) {
        return { ...normalized, reason: "live" };
      }
    }
  } catch (err) {
    console.warn(`Redis unavailable (${(err as Error).message}); market feed unavailable.`);
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // Ignore disconnect cleanup error
      }
    }
  }

  if (!sampleDataEnabled()) {
    return {
      generatedAt: new Date().toISOString(),
      sportKey: sportKey ?? "all",
      games: [],
      props: [],
      reason: "feed_unavailable",
    };
  }

  const sport = sportKey?.toLowerCase();
  const only = sport?.includes("nfl") ? "nfl" : sport?.includes("nba") ? "nba" : null;
  if (only) {
    return {
      generatedAt: new Date().toISOString(),
      sportKey: only,
      games: FALLBACK_MARKET_BROWSER_FEED.games.filter((g) => g.sportKey === only),
      props: FALLBACK_MARKET_BROWSER_FEED.props.filter((p) => p.sportKey === only),
      reason: "sample",
    };
  }

  return { ...FALLBACK_MARKET_BROWSER_FEED, reason: "sample" };
}
