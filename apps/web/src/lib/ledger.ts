import type {
  StagedBet,
  BetLeg,
  TrackedBet,
  BetStatus,
  BetSummaryMetrics,
} from "@/types/bet";

export const STAGED_BETS_STORAGE_KEY = "parlaypal:staged_bets";
export const TRACKED_BETS_STORAGE_KEY = "parlaypal:tracked_bets";
export const GUEST_USER_ID_STORAGE_KEY = "parlaypal:guest_user_id";
export const MAX_STAGED_BETS_CAP = 100;
export const MAX_TRACKED_BETS_CAP = 200;

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
 */
export function updateTrackedBetStatus(betId: string, status: BetStatus): TrackedBet {
  const allBets = getTrackedBets();
  const existing = allBets.find((b) => b.betId === betId);
  if (!existing) {
    throw new Error(`Bet with id ${betId} not found.`);
  }

  const finalizedStatuses = new Set([
    "won",
    "lost",
    "settled_won",
    "settled_lost",
    "void",
    "push",
  ]);

  const currentStatus = (existing.status || "").toLowerCase();
  if (finalizedStatuses.has(currentStatus)) {
    throw new Error(`Cannot re-settle an already finalized bet with status: ${existing.status}`);
  }

  const updatedBet: TrackedBet = {
    ...existing,
    status,
    settledAt: finalizedStatuses.has(status) ? new Date().toISOString() : existing.settledAt,
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

/**
 * Calculates summary metrics for bet tracking dashboard.
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

  for (const bet of bets) {
    const s = (bet.status || "").toLowerCase();
    const stake = bet.stakeAmount || bet.stake || 0;
    const payout = bet.potentialPayout || (stake * (bet.decimalOdds || 1));

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
  }

  const netProfit = Number((totalReturn - totalSettledStaked).toFixed(2));
  const roi =
    totalSettledStaked > 0
      ? Number(((netProfit / totalSettledStaked) * 100).toFixed(2))
      : 0;

  return {
    totalBets: bets.length,
    stagedCount,
    pendingCount,
    wonCount,
    lostCount,
    activeAction: Number(activeAction.toFixed(2)),
    totalStaked: Number(totalStaked.toFixed(2)),
    totalSettledStaked: Number(totalSettledStaked.toFixed(2)),
    totalReturn: Number(totalReturn.toFixed(2)),
    netProfit,
    roi,
  };
}
