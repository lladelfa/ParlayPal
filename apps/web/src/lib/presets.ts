import type {
  CuratedPresetFeed,
  PresetCard,
  PresetLeg,
  WeatherBadge,
} from "@/types/preset";
import { createRedisClient, presetsFeedKey } from "@/lib/redis";
import { decimalToAmerican, recalculatePresetCard } from "./math";

export { decimalToAmerican, recalculatePresetCard };

type JsonRecord = Record<string, unknown>;

function pickField(obj: JsonRecord, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

export function coerceNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") {
    return null;
  }
  const num = typeof val === "number" ? val : Number(val);
  return Number.isFinite(num) ? num : null;
}

export function coerceString(val: unknown, fallback = ""): string {
  if (val === null || val === undefined) {
    return fallback;
  }
  return String(val);
}

export function coerceNullableString(val: unknown): string | null {
  if (val === null || val === undefined || val === "") {
    return null;
  }
  return String(val);
}

export function coerceNumber(val: unknown, fallback = 0): number {
  const num = coerceNullableNumber(val);
  return num ?? fallback;
}

export function normalizeWeatherBadge(raw: unknown): WeatherBadge | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  const badgeType = coerceString(
    pickField(obj, "badgeType", "badge_type"),
    "CLEAR",
  ) as WeatherBadge["badgeType"];
  return {
    badgeType,
    summary: coerceString(obj.summary),
    isThreat: Boolean(pickField(obj, "isThreat", "is_threat")),
  };
}

function normalizePresetLeg(raw: unknown): PresetLeg | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  const propId = coerceString(pickField(obj, "propId", "prop_id"));
  const eventId = coerceString(pickField(obj, "eventId", "event_id"));
  const playerName = coerceString(pickField(obj, "playerName", "player_name"));
  if (!propId || !playerName) {
    return null;
  }
  const rawForm = pickField(obj, "sofascoreForm", "sofascore_form");
  const sofascoreForm = Array.isArray(rawForm) ? rawForm.map(Boolean) : [];
  const rawSel = coerceString(obj.selection, "OVER").toUpperCase();

  return {
    propId,
    eventId,
    playerName,
    teamAbbreviation: coerceString(
      pickField(obj, "teamAbbreviation", "team_abbreviation"),
      "TBD",
    ),
    matchup: coerceString(obj.matchup),
    marketKey: coerceString(pickField(obj, "marketKey", "market_key")),
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
      "0.5000",
    ),
    guardedEv: coerceString(pickField(obj, "guardedEv", "guarded_ev"), "0.0000"),
    hitRateL5: coerceNullableString(pickField(obj, "hitRateL5", "hit_rate_l5")),
    hitRateL10: coerceNullableString(pickField(obj, "hitRateL10", "hit_rate_l10")),
    hitRateSeason: coerceNullableString(
      pickField(obj, "hitRateSeason", "hit_rate_season"),
    ),
    hitRateDisplay: coerceNullableString(
      pickField(obj, "hitRateDisplay", "hit_rate_display"),
    ),
    sofascoreForm,
    sofascoreDots: coerceString(
      pickField(obj, "sofascoreDots", "sofascore_dots"),
      "",
    ),
    weatherBadge: normalizeWeatherBadge(
      pickField(obj, "weatherBadge", "weather_badge"),
    ),
    convictionRationale: coerceString(
      pickField(obj, "convictionRationale", "conviction_rationale"),
    ),
  };
}

export function normalizeCuratedPresetFeed(raw: unknown): CuratedPresetFeed | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as JsonRecord;
  if (!Array.isArray(obj.cards)) {
    return null;
  }
  const cards: PresetCard[] = [];
  for (const rawCard of obj.cards) {
    if (!rawCard || typeof rawCard !== "object") {
      continue;
    }
    const c = rawCard as JsonRecord;
    const rawLegs = Array.isArray(c.legs) ? c.legs : [];
    const legs = rawLegs
      .map(normalizePresetLeg)
      .filter((leg): leg is PresetLeg => leg !== null);
    const presetId = coerceString(pickField(c, "presetId", "preset_id"));
    const title = coerceString(c.title);
    if (!presetId || !title || legs.length === 0) {
      continue;
    }
    const rawSport = coerceString(
      pickField(c, "sportKey", "sport_key"),
      "nfl",
    ).toLowerCase();
    cards.push({
      presetId,
      title,
      sportKey: rawSport.includes("nba") ? "nba" : "nfl",
      themeBadge: coerceString(pickField(c, "themeBadge", "theme_badge")),
      legs,
      combinedDecimalOdds: coerceString(
        pickField(c, "combinedDecimalOdds", "combined_decimal_odds"),
        "2.0000",
      ),
      combinedAmericanOdds: coerceNumber(
        pickField(c, "combinedAmericanOdds", "combined_american_odds"),
        100,
      ),
      combinedFairProbability: coerceString(
        pickField(c, "combinedFairProbability", "combined_fair_probability"),
        "0.50000",
      ),
      combinedEv: coerceString(pickField(c, "combinedEv", "combined_ev"), "0.0000"),
      hybridValueScore: coerceNumber(
        pickField(c, "hybridValueScore", "hybrid_value_score"),
        0,
      ),
      status: coerceString(c.status, "ACTIVE") as PresetCard["status"],
      commenceTime: coerceString(
        pickField(c, "commenceTime", "commence_time"),
        new Date().toISOString(),
      ),
    });
  }
  return {
    generatedAt: coerceString(
      pickField(obj, "generatedAt", "generated_at"),
      new Date().toISOString(),
    ),
    cards,
  };
}

export const FALLBACK_PRESET_FEED: CuratedPresetFeed = {
  generatedAt: new Date().toISOString(),
  cards: [
    {
      presetId: "c1a01111-2222-3333-4444-555566667701",
      title: "The Red Zone Express",
      sportKey: "nfl",
      themeBadge: "NFL · 2-Leg Anytime TD",
      combinedDecimalOdds: "3.7800",
      combinedAmericanOdds: 278,
      combinedFairProbability: "0.29580",
      combinedEv: "0.1181",
      hybridValueScore: 89,
      status: "ACTIVE",
      commenceTime: new Date(Date.now() + 4 * 3600000).toISOString(),
      legs: [
        {
          propId: "p1111111-1111-1111-1111-111111111111",
          eventId: "e1111111-1111-1111-1111-111111111111",
          playerName: "Derrick Henry",
          teamAbbreviation: "BAL",
          matchup: "BAL @ PIT",
          marketKey: "player_anytime_td",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          lineValue: 0.5,
          offeredDecimalOdds: "1.8000",
          offeredAmericanOdds: -125,
          sharpDecimalOdds: "1.7500",
          sharpAmericanOdds: -133,
          fairProbability: "0.5800",
          guardedEv: "0.0440",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
        {
          propId: "p2222222-2222-2222-2222-222222222222",
          eventId: "e2222222-2222-2222-2222-222222222222",
          playerName: "CeeDee Lamb",
          teamAbbreviation: "DAL",
          matchup: "DAL @ PHI",
          marketKey: "player_anytime_td",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          lineValue: 0.5,
          offeredDecimalOdds: "2.1000",
          offeredAmericanOdds: 110,
          sharpDecimalOdds: "2.0000",
          sharpAmericanOdds: 100,
          fairProbability: "0.5100",
          guardedEv: "0.0710",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
      ],
    },
    {
      presetId: "c2a02222-3333-4444-5555-666677778802",
      title: "The Floor Generals",
      sportKey: "nba",
      themeBadge: "NBA · 2-Leg Playmakers",
      combinedDecimalOdds: "3.6273",
      combinedAmericanOdds: 263,
      combinedFairProbability: "0.29700",
      combinedEv: "0.0773",
      hybridValueScore: 92,
      status: "ACTIVE",
      commenceTime: new Date(Date.now() + 5 * 3600000).toISOString(),
      legs: [
        {
          propId: "p3333333-3333-3333-3333-333333333333",
          eventId: "e3333333-3333-3333-3333-333333333333",
          playerName: "Luka Doncic",
          teamAbbreviation: "DAL",
          matchup: "DAL @ LAL",
          marketKey: "player_points",
          marketDisplay: "Over 28.5 Points",
          selection: "OVER",
          lineValue: 28.5,
          offeredDecimalOdds: "1.9091",
          offeredAmericanOdds: -110,
          sharpDecimalOdds: "1.8500",
          sharpAmericanOdds: -118,
          fairProbability: "0.5500",
          guardedEv: "0.0500",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
        {
          propId: "p4444444-4444-4444-4444-444444444444",
          eventId: "e4444444-4444-4444-4444-444444444444",
          playerName: "Tyrese Haliburton",
          teamAbbreviation: "IND",
          matchup: "IND @ MIA",
          marketKey: "player_points",
          marketDisplay: "Over 19.5 Points",
          selection: "OVER",
          lineValue: 19.5,
          offeredDecimalOdds: "1.9000",
          offeredAmericanOdds: -111,
          sharpDecimalOdds: "1.8300",
          sharpAmericanOdds: -120,
          fairProbability: "0.5400",
          guardedEv: "0.0260",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
      ],
    },
    {
      presetId: "c3a03333-4444-5555-6666-777788889903",
      title: "Prime Time Aerial Attack",
      sportKey: "nfl",
      themeBadge: "NFL · 3-Leg Passing & Receiving",
      combinedDecimalOdds: "6.8500",
      combinedAmericanOdds: 585,
      combinedFairProbability: "0.15800",
      combinedEv: "0.0823",
      hybridValueScore: 86,
      status: "ACTIVE",
      commenceTime: new Date(Date.now() + 6 * 3600000).toISOString(),
      legs: [
        {
          propId: "p5555555-5555-5555-5555-555555555555",
          eventId: "e5555555-5555-5555-5555-555555555555",
          playerName: "Josh Allen",
          teamAbbreviation: "BUF",
          matchup: "BUF @ NYJ",
          marketKey: "player_pass_yds",
          marketDisplay: "Over 235.5 Pass Yds",
          selection: "OVER",
          lineValue: 235.5,
          offeredDecimalOdds: "1.8700",
          offeredAmericanOdds: -115,
          sharpDecimalOdds: "1.8000",
          sharpAmericanOdds: -125,
          fairProbability: "0.5550",
          guardedEv: "0.0378",
          hitRateL5: null,
          hitRateL10: null,
          hitRateSeason: null,
          hitRateDisplay: null,
          sofascoreForm: [],
          sofascoreDots: "",
          weatherBadge: {
            badgeType: "CLEAR",
            summary: "Clear · 38°F",
            isThreat: false,
          },
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
        {
          propId: "p6666666-6666-6666-6666-666666666666",
          eventId: "e6666666-6666-6666-6666-666666666666",
          playerName: "Amon-Ra St. Brown",
          teamAbbreviation: "DET",
          matchup: "DET @ MIN",
          marketKey: "player_anytime_td",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          lineValue: 0.5,
          offeredDecimalOdds: "2.0500",
          offeredAmericanOdds: 105,
          sharpDecimalOdds: "1.9500",
          sharpAmericanOdds: -105,
          fairProbability: "0.5200",
          guardedEv: "0.0660",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
        {
          propId: "p7777777-7777-7777-7777-777777777777",
          eventId: "e7777777-7777-7777-7777-777777777777",
          playerName: "Travis Kelce",
          teamAbbreviation: "KC",
          matchup: "KC @ DEN",
          marketKey: "player_anytime_td",
          marketDisplay: "Anytime Touchdown",
          selection: "OVER",
          lineValue: 0.5,
          offeredDecimalOdds: "1.7900",
          offeredAmericanOdds: -127,
          sharpDecimalOdds: "1.7200",
          sharpAmericanOdds: -139,
          fairProbability: "0.5850",
          guardedEv: "0.0471",
          hitRateL5: null,
          hitRateL10: null,
          hitRateSeason: null,
          hitRateDisplay: null,
          sofascoreForm: [],
          sofascoreDots: "",
          weatherBadge: {
            badgeType: "CLEAR",
            summary: "Clear · 45°F",
            isThreat: false,
          },
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
      ],
    },
    {
      presetId: "c4a04444-5555-6666-7777-888899990004",
      title: "Downtown Splash",
      sportKey: "nba",
      themeBadge: "NBA · 2-Leg Perimeter Snipers",
      combinedDecimalOdds: "4.1000",
      combinedAmericanOdds: 310,
      combinedFairProbability: "0.26000",
      combinedEv: "0.0660",
      hybridValueScore: 91,
      status: "ACTIVE",
      commenceTime: new Date(Date.now() + 7 * 3600000).toISOString(),
      legs: [
        {
          propId: "p8888888-8888-8888-8888-888888888888",
          eventId: "e8888888-8888-8888-8888-888888888888",
          playerName: "Stephen Curry",
          teamAbbreviation: "GSW",
          matchup: "GSW @ PHX",
          marketKey: "player_threes",
          marketDisplay: "Over 4.5 Threes",
          selection: "OVER",
          lineValue: 4.5,
          offeredDecimalOdds: "2.0500",
          offeredAmericanOdds: 105,
          sharpDecimalOdds: "1.9500",
          sharpAmericanOdds: -105,
          fairProbability: "0.5200",
          guardedEv: "0.0660",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
        {
          propId: "p9999999-9999-9999-9999-999999999999",
          eventId: "e9999999-9999-9999-9999-999999999999",
          playerName: "Jayson Tatum",
          teamAbbreviation: "BOS",
          matchup: "BOS @ NYK",
          marketKey: "player_threes",
          marketDisplay: "Over 3.5 Threes",
          selection: "OVER",
          lineValue: 3.5,
          offeredDecimalOdds: "2.0000",
          offeredAmericanOdds: 100,
          sharpDecimalOdds: "1.9200",
          sharpAmericanOdds: -109,
          fairProbability: "0.5300",
          guardedEv: "0.0600",
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
          convictionRationale:
            "Sample fixture leg shown while the live feed is unavailable.",
        },
      ],
    },
  ],
};

export function sampleDataEnabled(): boolean {
  const flag = (process.env.PARLAYPAL_SAMPLE_DATA ?? "").toLowerCase();
  return flag === "1" || flag === "true";
}

function sampleFeed(sportKey?: string): CuratedPresetFeed {
  const sport = sportKey?.toLowerCase();
  const cards =
    sport && (sport.includes("nfl") || sport.includes("nba"))
      ? FALLBACK_PRESET_FEED.cards.filter((c) => sport.includes(c.sportKey))
      : FALLBACK_PRESET_FEED.cards;
  return { generatedAt: new Date().toISOString(), cards, reason: "sample" };
}

export async function getCuratedPresetFeed(sportKey?: string): Promise<CuratedPresetFeed> {
  let redis: ReturnType<typeof createRedisClient> | null = null;
  let reason: "no_qualifying_presets" | "feed_unavailable" = "feed_unavailable";
  try {
    redis = createRedisClient();
    if (typeof redis.connect === "function") {
      await redis.connect();
    }
    const key = presetsFeedKey(sportKey);
    const snapshotKey = key.replace("presets:feed:", "presets:feed:snapshot:");
    const cached = (await redis.get(key)) ?? (await redis.get(snapshotKey));

    if (cached) {
      const normalized = normalizeCuratedPresetFeed(JSON.parse(cached));
      if (normalized && normalized.cards.length > 0) {
        return { ...normalized, reason: "live" };
      }
      if (normalized) {
        reason = "no_qualifying_presets";
      }
    }
  } catch (err) {
    console.warn(`Preset feed unavailable (${(err as Error).message}).`);
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // Ignore disconnect cleanup error
      }
    }
  }

  if (sampleDataEnabled()) {
    return sampleFeed(sportKey);
  }
  return { generatedAt: new Date().toISOString(), cards: [], reason };
}
