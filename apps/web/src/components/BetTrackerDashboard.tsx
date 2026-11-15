"use client";

import React, { useState, useEffect } from "react";
import type { TrackedBet, BetFilterStatus, ClvEdgeBucket } from "@/types/bet";
import {
  getTrackedBets,
  confirmStagedBet,
  updateTrackedBetStatus,
  deleteTrackedBet,
  calculateBetSummaryMetrics,
  saveTrackedBet,
  getGuestUserId,
  validateClvBenchmarkInput,
  CLV_MIN_PERCENT,
  CLV_MAX_POSITIVE_PERCENT,
  MIN_DECIMAL_ODDS,
  MAX_DECIMAL_ODDS,
} from "@/lib/ledger";
import { decimalToAmerican } from "@/lib/math";

interface BetTrackerDashboardProps {
  initialBets?: TrackedBet[];
  onNavigate?: (tab: "presets" | "browser" | "bets") => void;
}

function formatAmericanOdds(american: number): string {
  if (american > 0) return `+${american}`;
  return `${american}`;
}

function quantizeClvDisplay(value: number): number {
  const rounded3 = Number(value.toFixed(3));
  return rounded3 === 0 ? 0 : rounded3;
}

function formatClvPercent(value: number): string {
  const quantized3 = quantizeClvDisplay(value);
  if (quantized3 === 0) {
    return "0.0%";
  }
  const rounded2 = Number(value.toFixed(2));
  const normalized2 = rounded2 === 0 ? 0 : rounded2;
  if (normalized2 === 0) {
    return quantized3 > 0
      ? `+${quantized3.toFixed(3)}%`
      : `${quantized3.toFixed(3)}%`;
  }
  const hasHundredths = Math.round(Math.abs(normalized2) * 100) % 10 !== 0;
  const formatted = hasHundredths
    ? normalized2.toFixed(2)
    : normalized2.toFixed(1);
  if (normalized2 > 0) return `+${formatted}%`;
  return `${formatted}%`;
}

function parseFiniteClvValue(raw: unknown): number | null {
  if (raw === undefined || raw === null || typeof raw === "boolean") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveSyncUserId(bet: Partial<TrackedBet>): string {
  return typeof bet.userId === "string" && bet.userId.trim()
    ? bet.userId.trim()
    : getGuestUserId();
}

export function extractSanitizedClvSyncFields(
  bet: Partial<TrackedBet>,
): {
  closingDecimalOdds?: number;
  closingFairProb?: number;
  clvPercentage?: number;
} {
  if ((bet.status || "").trim().toLowerCase() === "staged") {
    return {};
  }

  const candidate: Record<string, unknown> = {};
  if (bet.closingDecimalOdds !== undefined && bet.closingDecimalOdds !== null) {
    candidate.closingDecimalOdds = bet.closingDecimalOdds;
  }
  if (bet.closingFairProb !== undefined && bet.closingFairProb !== null) {
    candidate.closingFairProb = bet.closingFairProb;
  }
  if (bet.clvPercentage !== undefined && bet.clvPercentage !== null) {
    candidate.clvPercentage = bet.clvPercentage;
  }

  if (Object.keys(candidate).length === 0) {
    return {};
  }

  const validation = validateClvBenchmarkInput(candidate);
  if (!validation.ok) {
    return {};
  }

  return {
    ...(validation.closingDecimalOdds !== undefined &&
    validation.closingDecimalOdds !== null
      ? { closingDecimalOdds: validation.closingDecimalOdds }
      : {}),
    ...(validation.closingFairProb !== undefined &&
    validation.closingFairProb !== null
      ? { closingFairProb: validation.closingFairProb }
      : {}),
    ...(validation.clvPercentage !== undefined &&
    validation.clvPercentage !== null
      ? { clvPercentage: validation.clvPercentage }
      : {}),
  };
}

async function syncBetRequest(
  fetchImpl: typeof fetch,
  url: string,
  method: "PATCH" | "POST",
  userId: string,
  payload: unknown,
): Promise<void> {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-user-id": userId,
      },
      body: JSON.stringify(payload),
    });
    if (response && !response.ok) {
      console.warn(`Bet sync failed (${method} ${url}): HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`Bet sync failed (${method} ${url}):`, err);
  }
}

/**
 * Settles a tracked bet locally (stamping simulated CLV benchmarks when unstamped)
 * and syncs the updated status and CLV fields to `PATCH /api/bets/[id]`.
 */
export function performBetSettlement(
  bet: TrackedBet,
  outcome: "won" | "lost",
  fetchImpl: typeof fetch = fetch,
): TrackedBet {
  const updated = updateTrackedBetStatus(bet.betId, outcome);
  const syncUserId = resolveSyncUserId(bet);
  const sanitizedClv = extractSanitizedClvSyncFields(updated);

  const payload: Record<string, unknown> = {
    userId: syncUserId,
    status: outcome,
    ...sanitizedClv,
  };

  void syncBetRequest(
    fetchImpl,
    `/api/bets/${bet.betId}`,
    "PATCH",
    syncUserId,
    payload,
  );

  return updated;
}

function renderEdgeBucketList(
  title: string,
  buckets: ClvEdgeBucket[],
  emptyMessage: string,
) {
  return (
    <div className="rounded-xl bg-[#0a0e17]/70 border border-[#1e293b] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </h4>
        <span className="text-[11px] font-telemetry text-text-muted">
          {buckets.length} {buckets.length === 1 ? "segment" : "segments"}
        </span>
      </div>

      {buckets.length === 0 ? (
        <p className="text-xs text-text-muted py-3">{emptyMessage}</p>
      ) : (
        <div className="space-y-2.5">
          {buckets.map((bucket) => {
            const bucketClvSign = quantizeClvDisplay(bucket.averageClvPercentage);
            const isPositive = bucketClvSign > 0;
            const isNegative = bucketClvSign < 0;
            const clvColorClass = isPositive
              ? "text-[#10b981]"
              : isNegative
              ? "text-[#ef4444]"
              : "text-text-muted";
            const clampedWidth = Math.max(
              0,
              Math.min(100, Number.isFinite(bucket.beatRate) ? bucket.beatRate : 0),
            );
            const barColorClass =
              clampedWidth >= 50
                ? "bg-[#10b981]"
                : clampedWidth > 0
                ? "bg-[#f59e0b]"
                : "bg-slate-500";

            return (
              <div
                key={bucket.key}
                className="rounded-lg bg-[#121b2d]/70 border border-[#1e293b] px-3 py-2.5 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-text-primary truncate">
                      {bucket.label}
                    </span>
                    <span className="rounded bg-[#1e293b] px-1.5 py-0.5 text-[10px] font-telemetry text-text-muted">
                      {bucket.trackedCount}{" "}
                      {bucket.trackedCount === 1 ? "bet" : "bets"}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 font-telemetry">
                    <span className="text-[11px] text-text-muted">
                      {bucket.beatRate.toFixed(1)}% beat ({bucket.beatCount}/
                      {bucket.trackedCount})
                    </span>
                    <span className={`font-bold ${clvColorClass}`}>
                      {formatClvPercent(bucket.averageClvPercentage)}
                    </span>
                  </div>
                </div>

                <div
                  role="progressbar"
                  aria-valuenow={clampedWidth}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${bucket.label} closing line beat rate`}
                  className="h-1.5 w-full rounded-full bg-[#0a0e17] border border-[#1e293b] overflow-hidden"
                >
                  <div
                    className={`h-full rounded-full ${barColorClass}`}
                    style={{ width: `${clampedWidth}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BetTrackerDashboard({
  initialBets,
  onNavigate,
}: BetTrackerDashboardProps) {
  const [bets, setBets] = useState<TrackedBet[]>(() => {
    if (initialBets !== undefined) return initialBets;
    return getTrackedBets();
  });
  const [activeFilter, setActiveFilter] = useState<BetFilterStatus>("all");
  const [stakeInputs, setStakeInputs] = useState<Record<string, string>>({});
  const [stakeErrors, setStakeErrors] = useState<Record<string, string>>({});
  const [discardedToast, setDiscardedToast] = useState<{
    bet: TrackedBet;
    message: string;
  } | null>(null);

  // Load persisted bets from localStorage on mount and reconcile with server
  useEffect(() => {
    if (!initialBets || initialBets.length === 0) {
      const loaded = getTrackedBets();
      setBets(loaded);

      const userId = getGuestUserId();
      fetch(`/api/bets?userId=${userId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && Array.isArray(data.bets) && data.bets.length > 0) {
            for (const b of data.bets) {
              saveTrackedBet(b);
            }
            setBets(getTrackedBets());
          }
        })
        .catch(() => {});
    }
  }, [initialBets]);

  // Auto-dismiss discard toast after 5 seconds
  useEffect(() => {
    if (discardedToast) {
      const timer = setTimeout(() => {
        setDiscardedToast(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [discardedToast]);

  const metrics = calculateBetSummaryMetrics(bets);

  // Filtered bets list
  const filteredBets = bets.filter((bet) => {
    const s = bet.status?.toLowerCase();
    if (activeFilter === "all") return true;
    if (activeFilter === "staged") return s === "staged";
    if (activeFilter === "pending") return s === "pending";
    if (activeFilter === "won") return s === "won" || s === "settled_won";
    if (activeFilter === "lost") return s === "lost" || s === "settled_lost";
    return true;
  });

  const handleStakeChange = (betId: string, val: string) => {
    setStakeInputs((prev) => ({ ...prev, [betId]: val }));
    if (stakeErrors[betId]) {
      setStakeErrors((prev) => {
        const next = { ...prev };
        delete next[betId];
        return next;
      });
    }
  };

  const handleConfirm = async (bet: TrackedBet) => {
    const rawVal = stakeInputs[bet.betId] ?? String(bet.stakeAmount ?? 50);
    const parsedStake = parseFloat(rawVal);

    if (isNaN(parsedStake) || parsedStake <= 0) {
      setStakeErrors((prev) => ({
        ...prev,
        [bet.betId]: "Stake must be greater than $0.00",
      }));
      return;
    }

    try {
      const updated = confirmStagedBet(bet.betId, parsedStake);
      setBets(getTrackedBets());

      // Best effort backend sync
      fetch(`/api/bets/${bet.betId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: bet.userId,
          status: "pending",
          stakeAmount: parsedStake,
        }),
      }).catch(() => {
        // Handled silently by offline fallback
      });
    } catch (err: any) {
      setStakeErrors((prev) => ({
        ...prev,
        [bet.betId]: err.message || "Failed to confirm bet",
      }));
    }
  };

  const handleDiscard = (bet: TrackedBet) => {
    deleteTrackedBet(bet.betId);
    setBets(getTrackedBets());
    const stakeDisplay = (bet.stakeAmount ?? (bet as any).stake ?? 0).toFixed(2);
    setDiscardedToast({
      bet,
      message: `Discarded ${bet.sportsbook} ticket ($${stakeDisplay})`,
    });

    fetch(`/api/bets/${bet.betId}?userId=${bet.userId}`, {
      method: "DELETE",
    }).catch(() => {});
  };

  const handleUndoDiscard = () => {
    if (discardedToast) {
      saveTrackedBet(discardedToast.bet);
      setBets(getTrackedBets());
      const syncUserId = resolveSyncUserId(discardedToast.bet);
      const {
        closingDecimalOdds: _rawOdds,
        closingFairProb: _rawProb,
        clvPercentage: _rawClv,
        ...restBet
      } = discardedToast.bet;
      const undoPayload = {
        ...restBet,
        userId: syncUserId,
        ...extractSanitizedClvSyncFields(discardedToast.bet),
      };
      void syncBetRequest(fetch, "/api/bets", "POST", syncUserId, undoPayload);
      setDiscardedToast(null);
    }
  };

  const handleSettle = (bet: TrackedBet, outcome: "won" | "lost") => {
    try {
      performBetSettlement(bet, outcome);
      setBets(getTrackedBets());
    } catch (err) {
      console.warn("Settlement error:", err);
    }
  };

  return (
    <div className="w-full space-y-6">
      {/* Toast Notification */}
      {discardedToast && (
        <div className="flex items-center justify-between rounded-lg bg-surface-card border border-border-hairline px-4 py-3 text-sm text-text-primary shadow-lg animate-in fade-in slide-in-from-top-2">
          <span>{discardedToast.message}</span>
          <button
            type="button"
            onClick={handleUndoDiscard}
            className="ml-4 font-semibold text-[#06b6d4] hover:underline cursor-pointer"
          >
            Undo
          </button>
        </div>
      )}

      {/* Summary Metrics Bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-4 flex flex-col justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Total Bets
          </span>
          <span className="text-2xl font-bold font-telemetry text-text-primary mt-1">
            {metrics.totalBets}
          </span>
        </div>

        <div className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-4 flex flex-col justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Active Action
          </span>
          <span className="text-2xl font-bold font-telemetry text-[#06b6d4] mt-1">
            ${metrics.activeAction.toFixed(2)}
          </span>
        </div>

        <div className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-4 flex flex-col justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Staged Slips
          </span>
          <span className="text-2xl font-bold font-telemetry text-[#f59e0b] mt-1">
            {metrics.stagedCount}
          </span>
        </div>

        <div className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-4 flex flex-col justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Net P/L
          </span>
          <span
            className={`text-2xl font-bold font-telemetry mt-1 ${
              metrics.netProfit >= 0 ? "text-[#10b981]" : "text-[#ef4444]"
            }`}
          >
            {metrics.netProfit >= 0
              ? `+$${metrics.netProfit.toFixed(2)}`
              : `-$${Math.abs(metrics.netProfit).toFixed(2)}`}
          </span>
        </div>

        <div className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-4 flex flex-col justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            ROI%
          </span>
          <span
            className={`text-2xl font-bold font-telemetry mt-1 ${
              metrics.roi >= 0 ? "text-[#10b981]" : "text-[#ef4444]"
            }`}
          >
            {metrics.roi >= 0
              ? `+${metrics.roi.toFixed(1)}%`
              : `${metrics.roi.toFixed(1)}%`}
          </span>
        </div>
      </div>

      {/* CLV Analytics & Edge Reporting */}
      <div className="rounded-2xl bg-[#121b2d] border border-[#1e293b] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-text-primary tracking-wide uppercase">
              CLV Analytics &amp; Edge Reporting
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Closing Line Value measured against post-commence sharp benchmarks
            </p>
          </div>
          <span className="rounded-full bg-[#0a0e17] border border-[#1e293b] px-2.5 py-1 text-[11px] font-telemetry text-[#06b6d4]">
            {metrics.clvTrackedCount} CLV Tracked
          </span>
        </div>

        {/* CLV Headline Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl bg-[#0a0e17]/70 border border-[#1e293b] p-4 space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Closing Line Beat Rate
            </span>
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={`text-2xl font-bold font-telemetry ${
                  metrics.clvTrackedCount === 0
                    ? "text-text-muted"
                    : metrics.closingLineBeatRate >= 50
                    ? "text-[#10b981]"
                    : "text-[#f59e0b]"
                }`}
              >
                {metrics.clvTrackedCount === 0
                  ? "0.0%"
                  : `${metrics.closingLineBeatRate.toFixed(1)}%`}
              </span>
              <span className="text-xs font-telemetry text-text-muted">
                {metrics.clvBeatCount} of {metrics.clvTrackedCount} bets beat closing line
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={
                metrics.clvTrackedCount === 0
                  ? 0
                  : Math.max(0, Math.min(100, metrics.closingLineBeatRate))
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Overall closing line beat rate"
              className="h-1.5 w-full rounded-full bg-[#121b2d] border border-[#1e293b] overflow-hidden"
            >
              <div
                className={`h-full rounded-full ${
                  metrics.closingLineBeatRate >= 50
                    ? "bg-[#10b981]"
                    : "bg-[#f59e0b]"
                }`}
                style={{
                  width: `${
                    metrics.clvTrackedCount === 0
                      ? 0
                      : Math.max(0, Math.min(100, metrics.closingLineBeatRate))
                  }%`,
                }}
              />
            </div>
          </div>

          <div className="rounded-xl bg-[#0a0e17]/70 border border-[#1e293b] p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Avg CLV%
              </span>
              <span className="rounded bg-[#121b2d] border border-[#1e293b] px-2 py-0.5 text-[11px] font-telemetry text-text-muted">
                ROI%:{" "}
                <span
                  className={
                    metrics.roi >= 0 ? "text-[#10b981]" : "text-[#ef4444]"
                  }
                >
                  {metrics.roi >= 0
                    ? `+${metrics.roi.toFixed(1)}%`
                    : `${metrics.roi.toFixed(1)}%`}
                </span>
              </span>
            </div>
            <div
              className={`text-2xl font-bold font-telemetry ${
                metrics.clvTrackedCount === 0
                  ? "text-text-muted"
                  : quantizeClvDisplay(metrics.averageClvPercentage) > 0
                  ? "text-[#10b981]"
                  : quantizeClvDisplay(metrics.averageClvPercentage) < 0
                  ? "text-[#ef4444]"
                  : "text-text-primary"
              }`}
            >
              {metrics.clvTrackedCount === 0
                ? "0.0%"
                : formatClvPercent(metrics.averageClvPercentage)}
            </div>
            <p className="text-xs font-telemetry text-text-muted">
              Stake-weighted · Unweighted:{" "}
              {metrics.clvTrackedCount === 0
                ? "0.0%"
                : formatClvPercent(metrics.unweightedAverageClvPercentage)}
            </p>
          </div>

          <div className="rounded-xl bg-[#0a0e17]/70 border border-[#1e293b] p-4 space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Edge Verification Guard
            </span>
            <div className="text-2xl font-bold font-telemetry text-[#06b6d4]">
              {metrics.clvTrackedCount}{" "}
              <span className="text-sm font-normal text-text-muted">
                eligible {metrics.clvTrackedCount === 1 ? "ticket" : "tickets"}
              </span>
            </div>
            <p className="text-xs text-text-muted">
              Excludes staged slips &amp; &gt;+10.0% suspect stale lines
            </p>
          </div>
        </div>

        {/* Edge Distribution Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {renderEdgeBucketList(
            "Edge Distribution · By Sport",
            metrics.bySport,
            "No CLV-stamped bets yet. Settle or stamp bets to view sport edge distribution.",
          )}
          {renderEdgeBucketList(
            "Edge Distribution · By Sportsbook",
            metrics.bySportsbook,
            "No CLV-stamped bets yet. Settle or stamp bets to view bookmaker edge distribution.",
          )}
        </div>
      </div>

      {/* Segmented Status Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1e293b] pb-4">
        <button
          type="button"
          onClick={() => setActiveFilter("all")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            activeFilter === "all"
              ? "bg-[#06b6d4] text-[#0a0e17] font-bold shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              : "bg-[#121b2d] text-text-muted hover:text-text-primary border border-[#1e293b]"
          }`}
        >
          All ({metrics.totalBets})
        </button>

        <button
          type="button"
          onClick={() => setActiveFilter("staged")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            activeFilter === "staged"
              ? "bg-[#06b6d4] text-[#0a0e17] font-bold shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              : "bg-[#121b2d] text-text-muted hover:text-text-primary border border-[#1e293b]"
          }`}
        >
          Staged ({metrics.stagedCount})
        </button>

        <button
          type="button"
          onClick={() => setActiveFilter("pending")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            activeFilter === "pending"
              ? "bg-[#06b6d4] text-[#0a0e17] font-bold shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              : "bg-[#121b2d] text-text-muted hover:text-text-primary border border-[#1e293b]"
          }`}
        >
          Pending / Live ({metrics.pendingCount})
        </button>

        <button
          type="button"
          onClick={() => setActiveFilter("won")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            activeFilter === "won"
              ? "bg-[#06b6d4] text-[#0a0e17] font-bold shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              : "bg-[#121b2d] text-text-muted hover:text-text-primary border border-[#1e293b]"
          }`}
        >
          Won ({metrics.wonCount})
        </button>

        <button
          type="button"
          onClick={() => setActiveFilter("lost")}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            activeFilter === "lost"
              ? "bg-[#06b6d4] text-[#0a0e17] font-bold shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              : "bg-[#121b2d] text-text-muted hover:text-text-primary border border-[#1e293b]"
          }`}
        >
          Lost ({metrics.lostCount})
        </button>
      </div>

      {/* Ticket List or Empty State */}
      {filteredBets.length === 0 ? (
        <div className="rounded-2xl bg-[#121b2d] border border-[#1e293b] p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-surface-canvas flex items-center justify-center text-3xl border border-[#1e293b]">
            🎫
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-primary">
              {activeFilter === "all"
                ? "No tracked bets yet"
                : activeFilter === "staged"
                ? "No staged slips awaiting placement"
                : activeFilter === "pending"
                ? "No active live bets"
                : activeFilter === "won"
                ? "No winning tickets settled yet"
                : "No settled lost tickets"}
            </h3>
            <p className="text-sm text-text-muted max-w-md mx-auto mt-1">
              {activeFilter === "all"
                ? "Build a high-conviction parlay using curated presets or the schedule market browser to start tracking your closing line edge."
                : "Switch to another status tab or build a new wager to track."}
            </p>
          </div>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate("presets")}
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#06b6d4] px-4 py-2 font-display text-sm font-bold text-[#0a0e17] shadow-[0_0_12px_rgba(6,182,212,0.35)] hover:bg-cyan-400 transition-all cursor-pointer"
            >
              ⚡ Explore Curated Presets
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredBets.map((bet) => {
            const normalizedStatus = (bet.status || "").trim().toLowerCase();
            const isStaged = normalizedStatus === "staged";
            const isPending = normalizedStatus === "pending";
            const isWon =
              normalizedStatus === "won" || normalizedStatus === "settled_won";
            const isLost =
              normalizedStatus === "lost" || normalizedStatus === "settled_lost";
            const isVoid =
              normalizedStatus === "void" || normalizedStatus === "push";

            const currentStakeVal =
              stakeInputs[bet.betId] ?? String(bet.stakeAmount ?? 50);
            const err = stakeErrors[bet.betId];
            const parsedClv = parseFiniteClvValue(bet.clvPercentage);
            const hasValidClv =
              !isStaged &&
              parsedClv !== null &&
              parsedClv >= CLV_MIN_PERCENT &&
              parsedClv <= CLV_MAX_POSITIVE_PERCENT;
            const quantizedTicketClv =
              hasValidClv && parsedClv !== null
                ? quantizeClvDisplay(parsedClv)
                : 0;
            const isSuspectClv =
              !isStaged &&
              parsedClv !== null &&
              parsedClv > CLV_MAX_POSITIVE_PERCENT;
            const parsedClosingOdds = parseFiniteClvValue(bet.closingDecimalOdds);
            const hasBoundedClosingOdds =
              !isStaged &&
              parsedClosingOdds !== null &&
              parsedClosingOdds >= MIN_DECIMAL_ODDS &&
              parsedClosingOdds <= MAX_DECIMAL_ODDS;
            const parsedClosingProb = parseFiniteClvValue(bet.closingFairProb);
            const hasBoundedClosingProb =
              !isStaged &&
              parsedClosingProb !== null &&
              parsedClosingProb > 0 &&
              parsedClosingProb < 1;
            const hasClosingBenchmark =
              !isStaged && (hasBoundedClosingOdds || hasBoundedClosingProb);
            const parsedExecOdds =
              parseFiniteClvValue(bet.decimalOdds) ??
              parseFiniteClvValue(bet.combinedDecimalOdds);
            const formattedExecAmerican =
              typeof bet.americanOdds === "number" &&
              Number.isFinite(bet.americanOdds)
                ? formatAmericanOdds(bet.americanOdds)
                : parsedExecOdds !== null &&
                    parsedExecOdds >= MIN_DECIMAL_ODDS &&
                    parsedExecOdds <= MAX_DECIMAL_ODDS
                  ? formatAmericanOdds(decimalToAmerican(parsedExecOdds))
                  : "--";

            return (
              <div
                key={bet.betId}
                className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-5 hover:border-[#334155] transition-all space-y-4"
              >
                {/* Header Row */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="rounded bg-[#1e293b] px-2.5 py-1 text-xs font-semibold text-text-primary uppercase tracking-wide">
                      {bet.sportsbook}
                    </span>

                    {/* Status Pill */}
                    {isStaged && (
                      <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 text-xs font-semibold text-[#f59e0b]">
                        Staged Slip
                      </span>
                    )}
                    {isPending && (
                      <span className="rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2.5 py-0.5 text-xs font-semibold text-[#06b6d4] flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#06b6d4] animate-pulse" />
                        Pending / Live
                      </span>
                    )}
                    {isWon && (
                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-xs font-semibold text-[#10b981]">
                        Won
                      </span>
                    )}
                    {isLost && (
                      <span className="rounded-full bg-rose-500/10 border border-rose-500/30 px-2.5 py-0.5 text-xs font-semibold text-[#ef4444]">
                        Lost
                      </span>
                    )}
                    {isVoid && (
                      <span className="rounded-full bg-slate-500/10 border border-slate-500/30 px-2.5 py-0.5 text-xs font-semibold text-slate-400">
                        Void
                      </span>
                    )}

                    {/* Per-Ticket CLV Badge */}
                    {hasValidClv && parsedClv !== null && (
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-bold font-telemetry border ${
                          quantizedTicketClv > 0
                            ? "bg-emerald-500/10 border-emerald-500/30 text-[#10b981]"
                            : quantizedTicketClv < 0
                            ? "bg-rose-500/10 border-rose-500/30 text-[#ef4444]"
                            : "bg-slate-500/10 border-slate-500/30 text-slate-300"
                        }`}
                      >
                        {formatClvPercent(parsedClv)} CLV
                      </span>
                    )}
                    {isSuspectClv && (
                      <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 text-xs font-semibold text-[#f59e0b]">
                        Suspect CLV (&gt;+10.0% excluded)
                      </span>
                    )}

                    {/* Live Game Score Pill / Commence Time */}
                    {bet.liveProgress?.period ? (
                      <span className="rounded bg-surface-canvas/60 border border-[#1e293b] px-2 py-0.5 text-xs font-telemetry text-text-primary flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-ping" />
                        {bet.liveProgress.period} · {bet.liveProgress.scoreDisplay || "In Progress"}
                      </span>
                    ) : (
                      <span className="text-xs font-telemetry text-text-muted">
                        {bet.placedAt
                          ? new Date(bet.placedAt).toLocaleTimeString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : bet.stagedAt
                          ? `Staged ${new Date(bet.stagedAt).toLocaleTimeString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : "Scheduled"}
                      </span>
                    )}
                  </div>

                  {/* Execution Odds & Closing Benchmark */}
                  <div className="flex flex-col items-end gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted">Odds:</span>
                      <span className="font-telemetry text-base font-bold text-text-primary">
                        {formattedExecAmerican}
                      </span>
                      <span className="font-telemetry text-xs text-text-muted">
                        ({parsedExecOdds !== null ? parsedExecOdds.toFixed(2) : "--"}x)
                      </span>
                    </div>
                    {hasClosingBenchmark && (
                      <div className="flex items-center gap-2 text-[11px] font-telemetry text-text-muted">
                        {hasBoundedClosingOdds && parsedClosingOdds !== null && (
                          <span>
                            Close:{" "}
                            {formatAmericanOdds(decimalToAmerican(parsedClosingOdds))}{" "}
                            ({parsedClosingOdds.toFixed(2)}x)
                          </span>
                        )}
                        {hasBoundedClosingProb && parsedClosingProb !== null && (
                          <span>
                            Fair Close: {(parsedClosingProb * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Legs Breakdown */}
                <div className="divide-y divide-[#1e293b]/60 rounded-lg bg-surface-canvas/40 border border-[#1e293b]/60 p-3">
                  {(Array.isArray(bet.legs) ? bet.legs : []).map((leg, idx) => (
                    <div
                      key={leg.propId || idx}
                      className="py-2 first:pt-0 last:pb-0 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-text-muted font-telemetry">
                          #{idx + 1}
                        </span>
                        <span className="font-semibold text-text-primary truncate">
                          {leg.playerName}
                          {leg.teamAbbreviation ? ` (${leg.teamAbbreviation})` : ""}
                        </span>
                        <span className="text-text-muted">·</span>
                        <span className="text-text-secondary truncate">
                          {leg.marketDisplay}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 font-telemetry">
                        {leg.liveProgress?.period && (
                          <span className="text-[11px] text-[#06b6d4]">
                            {leg.liveProgress.period}
                          </span>
                        )}
                        <span className="text-text-primary font-medium">
                          {leg.offeredAmericanOdds !== undefined
                            ? formatAmericanOdds(leg.offeredAmericanOdds)
                            : leg.offeredDecimalOdds}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Footer / Controls Row */}
                <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                  {/* Financials Display */}
                  <div className="flex items-center gap-4 text-xs">
                    <div>
                      <span className="text-text-muted">Stake: </span>
                      <span className="font-telemetry font-bold text-text-primary">
                        ${(bet.stakeAmount ?? (bet as any).stake ?? 0).toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-text-muted">Potential Payout: </span>
                      <span className="font-telemetry font-bold text-[#10b981]">
                        ${(bet.potentialPayout ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {/* Actions for Staged Slip */}
                  {isStaged && (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-muted">$</span>
                          <input
                            type="number"
                            step="1"
                            min="1"
                            value={currentStakeVal}
                            onChange={(e) =>
                              handleStakeChange(bet.betId, e.target.value)
                            }
                            aria-label="Stake amount"
                            className={`w-20 rounded bg-surface-canvas px-2 py-1 text-xs font-telemetry text-text-primary border transition-all ${
                              err
                                ? "border-[#ef4444] ring-1 ring-[#ef4444]"
                                : "border-[#1e293b] focus:border-[#06b6d4]"
                            }`}
                          />
                        </div>
                        {err && (
                          <span className="text-[11px] text-[#ef4444] mt-0.5">
                            {err}
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleConfirm(bet)}
                        className="rounded-lg bg-[#06b6d4] px-3.5 py-1.5 text-xs font-bold text-[#0a0e17] hover:bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.3)] transition-all cursor-pointer"
                      >
                        Confirm Placed
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDiscard(bet)}
                        className="rounded-lg border border-[#1e293b] px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-[#ef4444] hover:border-rose-500/40 transition-all cursor-pointer"
                      >
                        Discard
                      </button>
                    </div>
                  )}

                  {/* Demo Settlement Triggers for Pending Bets */}
                  {isPending && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-muted">Simulate Settle:</span>
                      <button
                        type="button"
                        onClick={() => handleSettle(bet, "won")}
                        className="rounded px-2.5 py-1 text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-[#10b981] hover:bg-emerald-500/20 transition-all cursor-pointer"
                      >
                        Won
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSettle(bet, "lost")}
                        className="rounded px-2.5 py-1 text-xs font-semibold bg-rose-500/10 border border-rose-500/30 text-[#ef4444] hover:bg-rose-500/20 transition-all cursor-pointer"
                      >
                        Lost
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
