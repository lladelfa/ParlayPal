import {
  VALID_BET_STATUSES,
  type StagedBet,
  type BetLeg,
  type TrackedBet,
  type BetStatus,
  type BetSummaryMetrics,
  type ClvEdgeBucket,
  type SportEdgeCategory,
} from "@/types/bet";
import { SPORTSBOOK_REGISTRY } from "@/types/lineshopper";

export const STAGED_BETS_STORAGE_KEY = "parlaypal:staged_bets";
export const TRACKED_BETS_STORAGE_KEY = "parlaypal:tracked_bets";
export const GUEST_USER_ID_STORAGE_KEY = "parlaypal:guest_user_id";
export const MAX_STAGED_BETS_CAP = 100;
export const MAX_TRACKED_BETS_CAP = 200;

export const CLV_MIN_PERCENT = -999.999;
export const CLV_MAX_POSITIVE_PERCENT = 10.0;
export const MIN_DECIMAL_ODDS = 1.01;
export const MAX_DECIMAL_ODDS = 9999.9999;

const ELIGIBLE_CLV_STATUSES = new Set([
  "pending",
  "won",
  "settled_won",
  "lost",
  "settled_lost",
  "push",
  "void",
]);

const FINALIZED_BET_STATUSES = new Set([
  "won",
  "lost",
  "settled_won",
  "settled_lost",
  "void",
  "push",
]);

const SPORT_CATEGORY_ORDER: readonly SportEdgeCategory[] = [
  "NFL",
  "NBA",
  "Multi-Sport",
  "Other",
];

const NFL_MARKET_KEYS = new Set([
  "player_anytime_td",
  "anytime_td",
  "player_first_td",
  "player_last_td",
  "player_2plus_td",
  "player_pass_yds",
  "player_passing_yds",
  "player_pass_tds",
  "player_pass_completions",
  "player_pass_attempts",
  "player_rush_yds",
  "player_rushing_yds",
  "player_rush_attempts",
  "player_receptions",
  "player_reception_yds",
  "player_receiving_yds",
  "player_rush_reception_yds",
  "player_interceptions",
  "player_turnovers",
  "player_kicking_points",
  "player_field_goals",
  "player_tackles_assists",
]);

const NBA_MARKET_KEYS = new Set([
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
  "player_blocks",
  "player_steals",
  "player_double_double",
  "player_triple_double",
  "player_points_rebounds_assists",
  "player_points_rebounds",
  "player_points_assists",
  "player_rebounds_assists",
]);

export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC4122 v4 UUID fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage && typeof window.localStorage.getItem === "function") {
      return window.localStorage;
    }
    if (typeof globalThis !== "undefined" && (globalThis as any).localStorage && typeof (globalThis as any).localStorage.getItem === "function") {
      return (globalThis as any).localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Returns a persistent guest user UUID v4 from localStorage, generating one if not found.
 */
export function getGuestUserId(): string {
  const storage = getStorage();
  if (!storage) {
    return generateUUID();
  }

  try {
    const existing = storage.getItem(GUEST_USER_ID_STORAGE_KEY);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
    const newId = generateUUID();
    storage.setItem(GUEST_USER_ID_STORAGE_KEY, newId);
    return newId;
  } catch {
    return generateUUID();
  }
}

/**
 * Retrieves the array of staged bets from client localStorage.
 * Handles SSR and corrupt JSON gracefully by returning an empty array.
 */
export function getStagedBets(): StagedBet[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(STAGED_BETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as StagedBet[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Saves a staged bet to client localStorage, deduplicating by betId,
 * prepending to front (most recent first), and enforcing a max cap of 100 entries.
 */
export function saveStagedBet(bet: StagedBet): StagedBet {
  const storage = getStorage();
  if (!storage) {
    return bet;
  }

  try {
    const current = getStagedBets();
    const filtered = current.filter((b) => b && typeof b === "object" && b.betId !== bet.betId);
    const updated = [bet, ...filtered].slice(0, MAX_STAGED_BETS_CAP);
    storage.setItem(STAGED_BETS_STORAGE_KEY, JSON.stringify(updated));

    // Also mirror into tracked bets storage
    saveTrackedBet({
      ...bet,
      status: "staged",
    });
  } catch (err) {
    console.warn("Failed to persist staged bet to localStorage:", err);
  }

  return bet;
}

/**
 * Clears all staged bets from localStorage.
 */
export function clearStagedBets(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(STAGED_BETS_STORAGE_KEY);
  } catch {
    // Ignore storage clear errors
  }
}

export interface StageBetLocallyInput {
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
  stagedAt?: string;
}

/**
 * Convenience helper to create and persist a StagedBet locally.
 */
export function stageBetLocally(input: StageBetLocallyInput): StagedBet {
  const decimalOdds = input.decimalOdds ?? input.combinedDecimalOdds ?? 1.01;
  if (isNaN(decimalOdds) || !isFinite(decimalOdds) || decimalOdds < 1.01) {
    throw new Error(`Invalid decimal odds: ${decimalOdds}. Must be >= 1.01.`);
  }

  // Validate that no leg has guardedEv > 0.10 or status === "SUSPECT_STALE_LINE"
  if (Array.isArray(input.legs)) {
    for (const leg of input.legs) {
      const ev =
        leg.guardedEv !== undefined && leg.guardedEv !== null
          ? parseFloat(String(leg.guardedEv))
          : undefined;
      if (ev !== undefined && !isNaN(ev) && ev > 0.10) {
        throw new Error(
          `Cannot stage suspect stale line: leg ${leg.playerName || leg.propId} has EV > 10.0% (${(ev * 100).toFixed(1)}%).`,
        );
      }
      if (
        (leg as any).status === "SUSPECT_STALE_LINE" ||
        (leg as any).isSuspectStaleLine
      ) {
        throw new Error(
          `Cannot stage suspect stale line: leg ${leg.playerName || leg.propId} is flagged as SUSPECT_STALE_LINE.`,
        );
      }
    }
  }

  const betId = input.betId || generateUUID();
  const userId = input.userId || getGuestUserId();
  const americanOdds = input.americanOdds ?? input.combinedAmericanOdds ?? 100;
  const stakeAmount = input.stakeAmount ?? input.stake ?? 50;
  const potentialPayout =
    input.potentialPayout ?? Number((stakeAmount * decimalOdds).toFixed(2));
  const quickpickUrl = input.quickpickUrl || "";
  const stagedAt = input.stagedAt || new Date().toISOString();

  const stagedBet: StagedBet = {
    betId,
    userId,
    sportsbook: input.sportsbook,
    decimalOdds,
    americanOdds,
    combinedDecimalOdds: decimalOdds,
    combinedAmericanOdds: americanOdds,
    stakeAmount,
    stake: stakeAmount,
    potentialPayout,
    status: "staged",
    legs: input.legs,
    quickpickUrl,
    stagedAt,
  };

  return saveStagedBet(stagedBet);
}

/**
 * Retrieves all tracked bets (staged, pending, won, lost, void) from localStorage.
 * Combines with any legacy/isolated staged bets and sorts by most recent first.
 */
export function getTrackedBets(): TrackedBet[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const rawTracked = storage.getItem(TRACKED_BETS_STORAGE_KEY);
    let trackedList: TrackedBet[] = [];
    if (rawTracked) {
      const parsed = JSON.parse(rawTracked);
      if (Array.isArray(parsed)) {
        trackedList = parsed as TrackedBet[];
      }
    }

    // Merge in any staged bets not yet tracked
    const stagedBets = getStagedBets();
    const existingIds = new Set(trackedList.map((b) => b.betId));

    for (const staged of stagedBets) {
      if (!existingIds.has(staged.betId)) {
        trackedList.push({
          ...staged,
          status: "staged",
        });
        existingIds.add(staged.betId);
      }
    }

    // Sort by timestamp descending
    trackedList.sort((a, b) => {
      const timeA = new Date(a.placedAt || a.stagedAt || 0).getTime();
      const timeB = new Date(b.placedAt || b.stagedAt || 0).getTime();
      return timeB - timeA;
    });

    return trackedList;
  } catch {
    return [];
  }
}

/**
 * Persists or updates a TrackedBet in client localStorage.
 */
export function saveTrackedBet(bet: TrackedBet): TrackedBet {
  const storage = getStorage();
  if (!storage) {
    return bet;
  }

  try {
    const rawTracked = storage.getItem(TRACKED_BETS_STORAGE_KEY);
    let current: TrackedBet[] = [];
    if (rawTracked) {
      const parsed = JSON.parse(rawTracked);
      if (Array.isArray(parsed)) {
        current = parsed;
      }
    }

    const filtered = current.filter((b) => b && b.betId !== bet.betId);
    const updated = [bet, ...filtered].slice(0, MAX_TRACKED_BETS_CAP);
    storage.setItem(TRACKED_BETS_STORAGE_KEY, JSON.stringify(updated));

    // If bet transitioned away from staged, also remove from staged bets storage
    if (bet.status !== "staged") {
      const currentStaged = getStagedBets();
      const filteredStaged = currentStaged.filter((b) => b.betId !== bet.betId);
      storage.setItem(STAGED_BETS_STORAGE_KEY, JSON.stringify(filteredStaged));
    }
  } catch (err) {
    console.warn("Failed to persist tracked bet to localStorage:", err);
  }

  return bet;
}

/**
 * Transitions a staged bet to pending with a confirmed stake amount and recalculated payout.
 */
export function confirmStagedBet(betId: string, stakeAmount: number): TrackedBet {
  const parsedStake = Number(stakeAmount);
  if (isNaN(parsedStake) || !isFinite(parsedStake) || parsedStake <= 0) {
    throw new Error("Stake must be greater than $0.00");
  }

  const allBets = getTrackedBets();
  const existing = allBets.find((b) => b.betId === betId);
  if (!existing) {
    throw new Error(`Bet with id ${betId} not found.`);
  }

  const currentStatus = (existing.status || "").toLowerCase();
  if (currentStatus !== "staged") {
    throw new Error(`Only staged bets can be confirmed. Current status is ${existing.status}.`);
  }

  const updatedBet: TrackedBet = {
    ...existing,
    status: "pending",
    stakeAmount: parsedStake,
    stake: parsedStake,
    potentialPayout: Number((parsedStake * existing.decimalOdds).toFixed(2)),
    placedAt: new Date().toISOString(),
  };

  return saveTrackedBet(updatedBet);
}

/**
 * Updates a bet's status (e.g. won, lost, void) and prevents re-settling finalized bets.
 * When settling an unstamped bet to a finalized outcome, deterministically populates
 * closing benchmark fields if `clvPercentage` is null/undefined without ever overwriting
 * existing non-null CLV fields.
 */
export function updateTrackedBetStatus(betId: string, status: BetStatus): TrackedBet {
  const allBets = getTrackedBets();
  const existing = allBets.find((b) => b.betId === betId);
  if (!existing) {
    throw new Error(`Bet with id ${betId} not found.`);
  }

  const currentStatus = (existing.status || "").trim().toLowerCase();
  if (FINALIZED_BET_STATUSES.has(currentStatus)) {
    throw new Error(`Cannot re-settle an already finalized bet with status: ${existing.status}`);
  }

  const normalizedTargetStatus = (status || "").trim().toLowerCase();
  const isFinalizing = FINALIZED_BET_STATUSES.has(normalizedTargetStatus);
  const existingClosingFairProb = parseFiniteNumeric(existing.closingFairProb);
  const existingClosingDecimalOdds = parseFiniteNumeric(existing.closingDecimalOdds);
  const existingClvPercentage = parseFiniteNumeric(existing.clvPercentage);
  const hasExistingClv =
    existingClvPercentage !== null ||
    existingClosingFairProb !== null ||
    existingClosingDecimalOdds !== null;
  const isTransitionFromStaged = currentStatus === "staged";
  const simulated =
    isFinalizing && !isTransitionFromStaged && !hasExistingClv
      ? computeSimulatedClosingBenchmark(existing)
      : null;

  const updatedBet: TrackedBet = {
    ...existing,
    status,
    settledAt: isFinalizing ? new Date().toISOString() : existing.settledAt,
    ...(simulated
      ? {
          closingFairProb: simulated.closingFairProb,
          closingDecimalOdds: simulated.closingDecimalOdds,
          clvPercentage: simulated.clvPercentage,
        }
      : {}),
  };

  return saveTrackedBet(updatedBet);
}

/**
 * Deletes a tracked bet from all localStorage keys.
 */
export function deleteTrackedBet(betId: string): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }

  try {
    let removed = false;
    const rawTracked = storage.getItem(TRACKED_BETS_STORAGE_KEY);
    if (rawTracked) {
      const parsed = JSON.parse(rawTracked);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((b: TrackedBet) => {
          if (b.betId === betId) {
            removed = true;
            return false;
          }
          return true;
        });
        storage.setItem(TRACKED_BETS_STORAGE_KEY, JSON.stringify(filtered));
      }
    }

    const currentStaged = getStagedBets();
    const filteredStaged = currentStaged.filter((b) => {
      if (b.betId === betId) {
        removed = true;
        return false;
      }
      return true;
    });
    storage.setItem(STAGED_BETS_STORAGE_KEY, JSON.stringify(filteredStaged));

    return removed;
  } catch {
    return false;
  }
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeBetStatusInput(
  rawStatus: unknown,
): { ok: true; status: BetStatus } | { ok: false; message: string } {
  if (typeof rawStatus !== "string") {
    return { ok: false, message: `Invalid bet status: ${String(rawStatus)}` };
  }
  const normalized = rawStatus.trim().toLowerCase();
  if (!(VALID_BET_STATUSES as readonly string[]).includes(normalized)) {
    return { ok: false, message: `Invalid bet status: ${rawStatus}` };
  }
  return { ok: true, status: normalized as BetStatus };
}

function roundTo(value: number, decimals: number): number {
  const rounded = Number(value.toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseFiniteNumeric(raw: unknown): number | null {
  if (raw === undefined || raw === null || typeof raw === "boolean") {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseEligibleClvPercentage(raw: unknown): number | null {
  const parsed = parseFiniteNumeric(raw);
  if (parsed === null) {
    return null;
  }
  if (parsed < CLV_MIN_PERCENT || parsed > CLV_MAX_POSITIVE_PERCENT) {
    return null;
  }
  const quantized = roundTo(parsed, 3);
  if (quantized < CLV_MIN_PERCENT || quantized > CLV_MAX_POSITIVE_PERCENT) {
    return null;
  }
  return quantized;
}

function fnv1aHashUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Deterministically computes realistic closing benchmark values for local/demo settlement
 * when a tracked bet does not yet have worker-stamped CLV fields.
 */
export function computeSimulatedClosingBenchmark(bet: TrackedBet): {
  closingFairProb: number;
  closingDecimalOdds: number;
  clvPercentage: number;
} {
  const parsedPrimaryOdds = parseFiniteNumeric(bet.decimalOdds);
  const parsedCombinedOdds = parseFiniteNumeric(bet.combinedDecimalOdds);
  const resolvedOdds =
    parsedPrimaryOdds !== null && parsedPrimaryOdds >= MIN_DECIMAL_ODDS
      ? parsedPrimaryOdds
      : parsedCombinedOdds !== null && parsedCombinedOdds >= MIN_DECIMAL_ODDS
        ? parsedCombinedOdds
        : null;
  const dExec =
    resolvedOdds !== null
      ? clamp(resolvedOdds, MIN_DECIMAL_ODDS, MAX_DECIMAL_ODDS)
      : 2.0;

  const seed = `${bet.betId || "bet"}:${dExec.toFixed(4)}`;
  const unit = fnv1aHashUnit(seed);

  const legs = Array.isArray(bet.legs) ? bet.legs : [];
  const legEvs: number[] = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== "object") continue;
    const ev = parseFiniteNumeric(leg.guardedEv);
    if (ev !== null) {
      legEvs.push(ev);
    }
  }

  let targetClvPct: number;
  if (legEvs.length > 0) {
    const meanEvPct =
      (legEvs.reduce((sum, val) => sum + val, 0) / legEvs.length) * 100;
    const jitterPct = (unit - 0.5) * 2.0;
    targetClvPct = clamp(meanEvPct + jitterPct, -3.5, 5.5);
  } else {
    targetClvPct = -3.5 + unit * 9.0;
  }

  const rawProb = (1 + targetClvPct / 100) / dExec;
  let closingFairProb = roundTo(clamp(rawProb, 0.000001, 0.990099), 6);
  if (closingFairProb * dExec - 1 > 0.1) {
    closingFairProb = Math.floor((1.1 / dExec) * 1_000_000) / 1_000_000;
    while (closingFairProb > 0.000001 && closingFairProb * dExec - 1 > 0.1) {
      closingFairProb = roundTo(closingFairProb - 0.000001, 6);
    }
    closingFairProb = clamp(closingFairProb, 0.000001, 0.990099);
  }
  const closingDecimalOdds = roundTo(
    clamp(1 / closingFairProb, MIN_DECIMAL_ODDS, MAX_DECIMAL_ODDS),
    4,
  );
  const clvPercentage = roundTo(
    clamp(
      (closingFairProb * dExec - 1) * 100,
      CLV_MIN_PERCENT,
      CLV_MAX_POSITIVE_PERCENT,
    ),
    3,
  );

  return {
    closingFairProb,
    closingDecimalOdds,
    clvPercentage,
  };
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

type DetectedSportSignal = "NFL" | "NBA" | "MULTI" | "OTHER_EXPLICIT";

function detectSportFromText(rawSport: unknown): DetectedSportSignal | null {
  if (typeof rawSport !== "string") return null;
  const norm = rawSport.trim().toLowerCase();
  if (!norm) return null;

  const tokens = new Set(norm.split(/[^a-z0-9]+/).filter(Boolean));
  const hasNfl = tokens.has("nfl");
  const hasNba = tokens.has("nba");

  if (hasNfl && hasNba) {
    return "MULTI";
  }
  if (hasNfl) {
    return "NFL";
  }
  if (hasNba) {
    return "NBA";
  }
  return "OTHER_EXPLICIT";
}

function detectLegSport(leg: BetLeg): DetectedSportSignal | null {
  const rawSport = firstNonEmptyString(
    leg.sportKey,
    (leg as unknown as Record<string, unknown>).sport_key,
  );
  const explicitSport = detectSportFromText(rawSport);
  if (explicitSport !== null) {
    return explicitSport;
  }

  const rawMarketKey = firstNonEmptyString(
    leg.marketKey,
    (leg as unknown as Record<string, unknown>).marketType,
  );
  if (rawMarketKey) {
    const mk = rawMarketKey.toLowerCase();
    if (NFL_MARKET_KEYS.has(mk)) return "NFL";
    if (
      mk.includes("pass_") ||
      mk.includes("passing") ||
      mk.includes("rush_") ||
      mk.includes("rushing") ||
      mk.includes("receiving") ||
      mk.includes("reception") ||
      mk.includes("kicking") ||
      mk.includes("interception") ||
      mk.includes("turnover") ||
      mk.endsWith("_td") ||
      mk.includes("_td_")
    ) {
      return "NFL";
    }
    if (NBA_MARKET_KEYS.has(mk)) return "NBA";
  }

  const rawEventId = firstNonEmptyString(leg.eventId);
  if (rawEventId) {
    const evt = rawEventId.toLowerCase();
    const hasNflEvt = /(^|[_-])(americanfootball_nfl|nfl)([_-]|$)/.test(evt);
    const hasNbaEvt = /(^|[_-])(basketball_nba|nba)([_-]|$)/.test(evt);
    if (hasNflEvt && hasNbaEvt) return "MULTI";
    if (hasNflEvt) return "NFL";
    if (hasNbaEvt) return "NBA";
  }

  const rawDisplay = firstNonEmptyString(leg.marketDisplay);
  if (rawDisplay) {
    const disp = rawDisplay.toLowerCase();
    if (
      /\b(kicking points|touchdowns?|td|pass(?:ing)?\s+(?:yds|yards)|passing|rush(?:ing)?\s+(?:yds|yards)|rushing|receiv(?:ing)?\s+(?:yds|yards)|receptions?|receiving|interceptions?|turnovers?|field goals?|tackles)\b/.test(
        disp,
      )
    ) {
      return "NFL";
    }
    if (
      /\b(points|rebounds|assists|threes|3-pointers|steals|blocks|double-double|triple-double)\b/.test(
        disp,
      )
    ) {
      return "NBA";
    }
  }

  return null;
}

/**
 * Categorizes a tracked bet into `NFL`, `NBA`, `Multi-Sport`, or `Other`.
 */
export function resolveBetSportBucket(bet: TrackedBet): SportEdgeCategory {
  const seen = new Set<"NFL" | "NBA" | "OTHER_EXPLICIT">();
  const legs = Array.isArray(bet.legs) ? bet.legs : [];

  for (const leg of legs) {
    if (!leg || typeof leg !== "object") continue;
    const sport = detectLegSport(leg);
    if (sport === "MULTI") {
      return "Multi-Sport";
    }
    if (sport) {
      seen.add(sport);
    }
  }

  const rawTopSport = firstNonEmptyString(
    (bet as unknown as Record<string, unknown>).sportKey,
    (bet as unknown as Record<string, unknown>).sport_key,
  );
  const topLevelSport = detectSportFromText(rawTopSport);
  if (topLevelSport === "MULTI") {
    return "Multi-Sport";
  }

  if (seen.size > 1) {
    return "Multi-Sport";
  }
  if (seen.has("NFL")) {
    return "NFL";
  }
  if (seen.has("NBA")) {
    return "NBA";
  }
  if (seen.has("OTHER_EXPLICIT")) {
    return "Other";
  }

  if (topLevelSport === "NFL" || topLevelSport === "NBA") {
    return topLevelSport;
  }

  return "Other";
}

const SPORTSBOOK_CANONICAL_MAP = new Map<string, { key: string; label: string }>([
  ...Object.entries(SPORTSBOOK_REGISTRY).map(([id, entry]) => [
    id.toLowerCase().replace(/[^a-z0-9]/g, ""),
    { key: id, label: entry.name },
  ] as const),
  ["draftkings", { key: "draftkings", label: "DraftKings" }],
  ["dk", { key: "draftkings", label: "DraftKings" }],
  ["fanduel", { key: "fanduel", label: "FanDuel" }],
  ["fd", { key: "fanduel", label: "FanDuel" }],
  ["caesars", { key: "caesars", label: "Caesars" }],
  ["caesarspalace", { key: "caesars", label: "Caesars" }],
  ["czr", { key: "caesars", label: "Caesars" }],
  ["betmgm", { key: "betmgm", label: "BetMGM" }],
  ["mgm", { key: "betmgm", label: "BetMGM" }],
  ["fanatics", { key: "fanatics", label: "Fanatics" }],
  ["sleeper", { key: "sleeper", label: "Sleeper" }],
  ["espnbet", { key: "espnbet", label: "ESPN BET" }],
  ["pinnacle", { key: "pinnacle", label: "Pinnacle" }],
  ["circa", { key: "circa", label: "Circa" }],
  ["circasports", { key: "circa", label: "Circa" }],
  ["bet365", { key: "bet365", label: "Bet365" }],
]);

function formatCanonicalFallbackSportsbookLabel(cleanedWords: string): string {
  return cleanedWords
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function resolveSportsbookBucket(sportsbook: unknown): { key: string; label: string } {
  const raw = typeof sportsbook === "string" ? sportsbook.trim() : "";
  if (!raw) {
    return { key: "unknown", label: "Unknown" };
  }

  let normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const strippedNormalized = normalized.replace(/sportsbook$/, "");
  if (strippedNormalized) {
    normalized = strippedNormalized;
  }

  if (!normalized) {
    return { key: "unknown", label: "Unknown" };
  }

  const canonical = SPORTSBOOK_CANONICAL_MAP.get(normalized);
  if (canonical) {
    return canonical;
  }

  const cleanedWords =
    raw
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .replace(/\bsportsbook$/i, "")
      .trim() || raw.replace(/[^a-zA-Z0-9]+/g, " ").trim();

  return {
    key: normalized,
    label: cleanedWords ? formatCanonicalFallbackSportsbookLabel(cleanedWords) : "Unknown",
  };
}

interface ClvSampleEntry {
  clv: number;
  stake: number;
}

function buildClvEdgeBucket(
  key: string,
  label: string,
  entries: ClvSampleEntry[],
): ClvEdgeBucket {
  const trackedCount = entries.length;
  if (trackedCount === 0) {
    return {
      key,
      label,
      trackedCount: 0,
      beatCount: 0,
      beatRate: 0,
      averageClvPercentage: 0,
      unweightedAverageClvPercentage: 0,
      totalStaked: 0,
    };
  }

  let beatCount = 0;
  let sumClv = 0;
  let weightedSum = 0;
  let totalStake = 0;

  for (const entry of entries) {
    if (entry.clv > 0) {
      beatCount++;
    }
    sumClv += entry.clv;
    if (entry.stake > 0) {
      weightedSum += entry.clv * entry.stake;
      totalStake += entry.stake;
    }
  }

  const beatRate = roundTo((beatCount / trackedCount) * 100, 2);
  const unweightedAverageClvPercentage = roundTo(sumClv / trackedCount, 3);
  const averageClvPercentage =
    Number.isFinite(weightedSum) && Number.isFinite(totalStake) && totalStake > 0
      ? roundTo(weightedSum / totalStake, 3)
      : unweightedAverageClvPercentage;

  return {
    key,
    label,
    trackedCount,
    beatCount,
    beatRate,
    averageClvPercentage,
    unweightedAverageClvPercentage,
    totalStaked: Number.isFinite(totalStake) ? roundTo(totalStake, 2) : totalStake,
  };
}

export type ClvValidationResult =
  | {
      ok: true;
      closingDecimalOdds?: number | null;
      closingFairProb?: number | null;
      clvPercentage?: number | null;
    }
  | {
      ok: false;
      status: 400;
      code: "SUSPECT_STALE_LINE" | "INVALID_CLV";
      message: string;
    };

/**
 * Validates optional CLV benchmark fields (`closingDecimalOdds`, `closingFairProb`, `clvPercentage`)
 * for `/api/bets` write endpoints, enforcing Story 4.2 bounds and the positive-only +10.0%
 * outlier circuit breaker.
 */
export function validateClvBenchmarkInput(
  body: Record<string, unknown>,
): ClvValidationResult {
  const rawClosingOdds =
    body.closingDecimalOdds !== undefined
      ? body.closingDecimalOdds
      : body.closing_decimal_odds;
  const rawFairProb =
    body.closingFairProb !== undefined
      ? body.closingFairProb
      : body.closing_fair_prob;
  const rawClv =
    body.clvPercentage !== undefined ? body.clvPercentage : body.clv_percentage;

  let closingDecimalOdds: number | null | undefined = undefined;
  if (rawClosingOdds !== undefined) {
    if (rawClosingOdds === null) {
      closingDecimalOdds = null;
    } else {
      const parsed = parseFiniteNumeric(rawClosingOdds);
      if (parsed === null || parsed < MIN_DECIMAL_ODDS || parsed > MAX_DECIMAL_ODDS) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `closingDecimalOdds (${String(rawClosingOdds)}) must satisfy 1.01 <= D <= 9999.9999.`,
        };
      }
      const quantized = roundTo(parsed, 4);
      if (quantized < MIN_DECIMAL_ODDS || quantized > MAX_DECIMAL_ODDS) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `closingDecimalOdds (${quantized}) exceeds Numeric(8,4) bounds.`,
        };
      }
      closingDecimalOdds = quantized;
    }
  }

  let closingFairProb: number | null | undefined = undefined;
  if (rawFairProb !== undefined) {
    if (rawFairProb === null) {
      closingFairProb = null;
    } else {
      const parsed = parseFiniteNumeric(rawFairProb);
      if (parsed === null || parsed <= 0 || parsed >= 1) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `closingFairProb (${String(rawFairProb)}) must be strictly between 0 and 1.`,
        };
      }
      const quantized = roundTo(parsed, 5);
      if (quantized <= 0 || quantized >= 1) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `closingFairProb (${quantized}) must remain strictly within (0, 1) after quantization.`,
        };
      }
      closingFairProb = quantized;
    }
  }

  let clvPercentage: number | null | undefined = undefined;
  if (rawClv !== undefined) {
    if (rawClv === null) {
      clvPercentage = null;
    } else {
      const parsed = parseFiniteNumeric(rawClv);
      if (parsed === null) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `clvPercentage (${String(rawClv)}) must be a finite number.`,
        };
      }
      const quantized = roundTo(parsed, 3);
      if (parsed > CLV_MAX_POSITIVE_PERCENT || quantized > CLV_MAX_POSITIVE_PERCENT) {
        return {
          ok: false,
          status: 400,
          code: "SUSPECT_STALE_LINE",
          message: `clvPercentage (${parsed}%) exceeds +10.0% outlier circuit breaker.`,
        };
      }
      if (parsed < CLV_MIN_PERCENT || quantized < CLV_MIN_PERCENT) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_CLV",
          message: `clvPercentage (${parsed}%) is below minimum allowed bound (${CLV_MIN_PERCENT}%).`,
        };
      }
      clvPercentage = quantized;
    }
  }

  return {
    ok: true,
    closingDecimalOdds,
    closingFairProb,
    clvPercentage,
  };
}

/**
 * Calculates summary metrics and CLV edge analytics for the bet tracking dashboard.
 */
export function calculateBetSummaryMetrics(bets: TrackedBet[]): BetSummaryMetrics {
  let stagedCount = 0;
  let pendingCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let activeAction = 0;
  let totalSettledStaked = 0;
  let totalStaked = 0;
  let totalReturn = 0;

  const clvEntries: ClvSampleEntry[] = [];
  const sportMap = new Map<SportEdgeCategory, ClvSampleEntry[]>();
  const bookMap = new Map<string, { label: string; entries: ClvSampleEntry[] }>();

  for (const bet of bets) {
    const s = (bet.status || "").toLowerCase();
    const rawStake = parseFiniteNumeric(bet.stakeAmount) ?? parseFiniteNumeric(bet.stake);
    const stake = rawStake !== null && rawStake > 0 ? rawStake : 0;
    const payout = bet.potentialPayout || stake * (bet.decimalOdds || 1);

    if (s === "staged") {
      stagedCount++;
    } else if (s === "pending") {
      pendingCount++;
      activeAction += stake;
      totalStaked += stake;
    } else if (s === "won" || s === "settled_won") {
      wonCount++;
      totalSettledStaked += stake;
      totalStaked += stake;
      totalReturn += payout;
    } else if (s === "lost" || s === "settled_lost") {
      lostCount++;
      totalSettledStaked += stake;
      totalStaked += stake;
    } else if (s === "void" || s === "push") {
      // Void refunds stake
      totalSettledStaked += stake;
      totalStaked += stake;
      totalReturn += stake;
    }

    if (ELIGIBLE_CLV_STATUSES.has(s)) {
      const validClv = parseEligibleClvPercentage(bet.clvPercentage);
      if (validClv !== null) {
        const entry: ClvSampleEntry = { clv: validClv, stake };
        clvEntries.push(entry);

        const sportCategory = resolveBetSportBucket(bet);
        const sportList = sportMap.get(sportCategory) ?? [];
        sportList.push(entry);
        sportMap.set(sportCategory, sportList);

        const book = resolveSportsbookBucket(bet.sportsbook);
        const bookBucket = bookMap.get(book.key) ?? {
          label: book.label,
          entries: [],
        };
        bookBucket.entries.push(entry);
        bookMap.set(book.key, bookBucket);
      }
    }
  }

  const netProfit = roundTo(totalReturn - totalSettledStaked, 2);
  const roi =
    totalSettledStaked > 0
      ? roundTo((netProfit / totalSettledStaked) * 100, 2)
      : 0;

  const overallClv = buildClvEdgeBucket("all", "All", clvEntries);

  const bySport: ClvEdgeBucket[] = [];
  for (const category of SPORT_CATEGORY_ORDER) {
    const entries = sportMap.get(category);
    if (entries && entries.length > 0) {
      bySport.push(buildClvEdgeBucket(category, category, entries));
    }
  }

  const bySportsbook: ClvEdgeBucket[] = Array.from(bookMap.entries())
    .map(([key, bucket]) => buildClvEdgeBucket(key, bucket.label, bucket.entries))
    .sort((a, b) => {
      if (b.trackedCount !== a.trackedCount) {
        return b.trackedCount - a.trackedCount;
      }
      if (b.averageClvPercentage !== a.averageClvPercentage) {
        return b.averageClvPercentage - a.averageClvPercentage;
      }
      return a.label.localeCompare(b.label);
    });

  return {
    totalBets: bets.length,
    stagedCount,
    pendingCount,
    wonCount,
    lostCount,
    activeAction: roundTo(activeAction, 2),
    totalStaked: roundTo(totalStaked, 2),
    totalSettledStaked: roundTo(totalSettledStaked, 2),
    totalReturn: roundTo(totalReturn, 2),
    netProfit,
    roi,
    clvTrackedCount: overallClv.trackedCount,
    clvBeatCount: overallClv.beatCount,
    closingLineBeatRate: overallClv.beatRate,
    averageClvPercentage: overallClv.averageClvPercentage,
    unweightedAverageClvPercentage: overallClv.unweightedAverageClvPercentage,
    bySport,
    bySportsbook,
  };
}
