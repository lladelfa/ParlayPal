import type { StagedBet, BetLeg } from "@/types/bet";

export const STAGED_BETS_STORAGE_KEY = "parlaypal:staged_bets";
export const GUEST_USER_ID_STORAGE_KEY = "parlaypal:guest_user_id";
export const MAX_STAGED_BETS_CAP = 100;

function generateUUID(): string {
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
