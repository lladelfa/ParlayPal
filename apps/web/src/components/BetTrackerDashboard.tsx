"use client";

import React, { useState, useEffect } from "react";
import type { TrackedBet, BetFilterStatus } from "@/types/bet";
import {
  getTrackedBets,
  confirmStagedBet,
  updateTrackedBetStatus,
  deleteTrackedBet,
  calculateBetSummaryMetrics,
  saveTrackedBet,
  getGuestUserId,
} from "@/lib/ledger";

interface BetTrackerDashboardProps {
  initialBets?: TrackedBet[];
  onNavigate?: (tab: "presets" | "browser" | "bets") => void;
}

function formatAmericanOdds(american: number): string {
  if (american > 0) return `+${american}`;
  return `${american}`;
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
      fetch("/api/bets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discardedToast.bet),
      }).catch(() => {});
      setDiscardedToast(null);
    }
  };

  const handleSettle = (bet: TrackedBet, outcome: "won" | "lost") => {
    try {
      updateTrackedBetStatus(bet.betId, outcome);
      setBets(getTrackedBets());

      fetch(`/api/bets/${bet.betId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: bet.userId,
          status: outcome,
        }),
      }).catch(() => {});
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
            const isStaged = bet.status === "staged";
            const isPending = bet.status === "pending";
            const isWon = bet.status === "won" || bet.status === "settled_won";
            const isLost = bet.status === "lost" || bet.status === "settled_lost";
            const isVoid = bet.status === "void" || bet.status === "push";

            const currentStakeVal =
              stakeInputs[bet.betId] ?? String(bet.stakeAmount ?? 50);
            const err = stakeErrors[bet.betId];

            return (
              <div
                key={bet.betId}
                className="rounded-xl bg-[#121b2d] border border-[#1e293b] p-5 hover:border-[#334155] transition-all space-y-4"
              >
                {/* Header Row */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
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

                  {/* Execution Odds */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">Odds:</span>
                    <span className="font-telemetry text-base font-bold text-text-primary">
                      {formatAmericanOdds(bet.americanOdds)}
                    </span>
                    <span className="font-telemetry text-xs text-text-muted">
                      ({bet.decimalOdds.toFixed(2)}x)
                    </span>
                  </div>
                </div>

                {/* Legs Breakdown */}
                <div className="divide-y divide-[#1e293b]/60 rounded-lg bg-surface-canvas/40 border border-[#1e293b]/60 p-3">
                  {bet.legs.map((leg, idx) => (
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
