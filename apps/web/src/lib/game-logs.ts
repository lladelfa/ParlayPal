import type { MarketPropRow } from "@/types/market";
import type { RedisClient } from "@/lib/redis";

/** Minimum games the worker requires before it caches a usable game log. */
export const MIN_LOG_GAMES = 5;

const UPSTREAM_SPORT: Record<"nfl" | "nba", string> = {
  nfl: "americanfootball_nfl",
  nba: "basketball_nba",
};

/** Mirrors worker `game_log_cache_key`: `gamelog:{sport}:{player}:{market}`. */
export function gameLogKey(
  sportKey: "nfl" | "nba",
  playerName: string,
  marketKey: string,
): string {
  return `gamelog:${UPSTREAM_SPORT[sportKey]}:${playerName}:${marketKey}`;
}

/** Parses a cached log (JSON list of decimal strings, newest first); null when unusable. */
export function parseGameLog(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length < MIN_LOG_GAMES) return null;
    const stats = data.map((v) =>
      typeof v === "number"
        ? v
        : typeof v === "string" && v.trim() !== ""
          ? Number(v)
          : NaN,
    );
    return stats.every((n) => Number.isFinite(n)) ? stats : null;
  } catch {
    return null;
  }
}

export type LineComparison = "over" | "under" | "push";

export function compareToLine(
  stat: number,
  line: number | null | undefined,
): LineComparison | null {
  if (line === null || line === undefined) return null;
  if (stat > line) return "over";
  if (stat < line) return "under";
  return "push";
}

/** propId -> newest-first stats, or null (missing, short, or read failure). Never throws. */
export async function readGameLogs(
  redis: Pick<RedisClient, "get">,
  props: MarketPropRow[],
): Promise<Record<string, number[] | null>> {
  const entries = await Promise.all(
    props.map(async (p): Promise<[string, number[] | null]> => {
      try {
        const raw = await redis.get(gameLogKey(p.sportKey, p.playerName, p.marketKey));
        return [p.propId, parseGameLog(raw)];
      } catch {
        return [p.propId, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}
