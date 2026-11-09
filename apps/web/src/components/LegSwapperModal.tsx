"use client";

import React, { useEffect, useState } from "react";
import { useParlayDrawer } from "@/context/ParlayDrawerContext";
import type { MarketPropRow } from "@/types/market";

export function LegSwapperModal() {
  const { swapModal, closeSwapModal, eligibleSwapCandidates, confirmSwap } =
    useParlayDrawer();
  const [searchQuery, setSearchQuery] = useState("");

  // Dismiss on Escape key
  useEffect(() => {
    if (!swapModal.isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeSwapModal();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [swapModal.isOpen, closeSwapModal]);

  if (!swapModal.isOpen || !swapModal.targetLeg) {
    return null;
  }

  const { targetLeg } = swapModal;

  const filteredCandidates = eligibleSwapCandidates.filter((candidate) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      candidate.playerName.toLowerCase().includes(q) ||
      candidate.teamAbbreviation.toLowerCase().includes(q) ||
      candidate.matchup.toLowerCase().includes(q) ||
      candidate.marketDisplay.toLowerCase().includes(q)
    );
  });

  return (
    <div
      onClick={closeSwapModal}
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-canvas/80 p-4 backdrop-blur-sm cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leg-swapper-modal-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border-hairline bg-surface-card shadow-2xl cursor-default"
      >
        {/* Header */}
        <header className="flex items-start justify-between border-b border-border-hairline p-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-surface-module px-2 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-wider text-accent-cyan border border-border-hairline">
                Leg Swapper · {targetLeg.sportKey.toUpperCase()}
              </span>
              <span className="text-xs text-text-muted">
                1-Click Alternative Replacement
              </span>
            </div>
            <h2
              id="leg-swapper-modal-title"
              className="mt-1.5 font-display text-lg font-bold text-text-primary"
            >
              Replace {targetLeg.playerName}
            </h2>
            <p className="text-xs text-text-muted font-sans">
              Currently: {targetLeg.marketDisplay} · {targetLeg.matchup}
            </p>
          </div>

          <button
            type="button"
            onClick={closeSwapModal}
            className="rounded-lg p-2 text-text-muted hover:bg-surface-module hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            ✕
          </button>
        </header>

        {/* Search Filter Bar */}
        <div className="border-b border-border-hairline/60 bg-surface-module/40 p-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search replacement candidates by player, team, or market..."
            className="w-full rounded-lg border border-border-hairline bg-surface-module px-3.5 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-cyan focus:outline-none transition-colors"
          />
        </div>

        {/* Candidate Pool List */}
        <div className="flex-1 overflow-y-auto divide-y divide-border-hairline/60 p-2">
          {filteredCandidates.length === 0 ? (
            <div className="py-12 text-center text-text-muted">
              <p className="font-display text-base font-semibold text-text-primary">
                No eligible replacement candidates
              </p>
              <p className="mt-1 text-xs font-sans">
                No alternative props found matching this sport slate and value criteria.
              </p>
            </div>
          ) : (
            filteredCandidates.map((candidate) => (
              <CandidateRow
                key={candidate.propId}
                candidate={candidate}
                onSelect={() => confirmSwap(targetLeg.propId, candidate)}
              />
            ))
          )}
        </div>

        {/* Modal Footer */}
        <footer className="flex items-center justify-between border-t border-border-hairline bg-surface-module/50 px-5 py-3 text-xs text-text-muted">
          <span>
            {filteredCandidates.length} eligible alternative{filteredCandidates.length === 1 ? "" : "s"} ranked by Hybrid Score
          </span>
          <button
            type="button"
            onClick={closeSwapModal}
            className="rounded-lg border border-border-hairline px-3.5 py-1.5 font-sans text-xs font-semibold text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  onSelect,
}: {
  candidate: MarketPropRow;
  onSelect: () => void;
}) {
  const evPct = (parseFloat(candidate.guardedEv) * 100).toFixed(1);
  const isPositiveEv = parseFloat(candidate.guardedEv) > 0;
  const formattedOdds =
    candidate.offeredAmericanOdds > 0
      ? `+${candidate.offeredAmericanOdds}`
      : `${candidate.offeredAmericanOdds}`;

  return (
    <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between hover:bg-surface-module/60 rounded-lg transition-colors">
      {/* Left: Player Avatar & Details */}
      <div className="flex items-start gap-3">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-module border border-border-hairline font-display text-xs font-bold text-text-primary">
          {candidate.playerName
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)}
          <span className="absolute -bottom-1 -right-1 rounded bg-surface-card px-1 py-0.2 text-[9px] font-bold text-accent-cyan border border-border-hairline">
            {candidate.teamAbbreviation}
          </span>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-sm font-bold text-text-primary">
              {candidate.playerName}
            </span>
            <span className="text-xs text-text-muted">· {candidate.matchup}</span>
            <span className="rounded bg-surface-module px-2 py-0.5 text-[11px] font-medium text-accent-cyan border border-border-hairline">
              {candidate.marketDisplay}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            {/* Sofascore Form Indicator */}
            {candidate.sofascoreForm && (
              <div className="flex items-center gap-1" title="L5 Form (oldest to newest)">
                {candidate.sofascoreForm?.map((hit, idx) => (
                  <span
                    key={idx}
                    className={`h-2.5 w-2.5 rounded-[3px] ${
                      hit ? "bg-accent-emerald" : "bg-accent-rose"
                    }`}
                  />
                ))}
              </div>
            )}
            <span className="font-telemetry text-xs font-medium text-text-muted">
              {candidate.hitRateDisplay}
            </span>

            {/* Weather / Dome Badge */}
            {candidate.weatherBadge && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium border ${
                  candidate.weatherBadge.isThreat
                    ? "bg-accent-amber/10 text-accent-amber border-accent-amber/30"
                    : "bg-surface-module text-text-muted border-border-hairline"
                }`}
              >
                {candidate.weatherBadge.summary}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right: Metrics & Select Button */}
      <div className="flex items-center justify-between sm:justify-end gap-3 self-end sm:self-center">
        {/* Guarded EV */}
        <span
          className={`rounded px-2 py-0.5 font-telemetry text-xs font-bold border border-border-hairline ${
            isPositiveEv
              ? "bg-surface-module text-accent-emerald"
              : "bg-surface-module text-text-muted"
          }`}
        >
          {isPositiveEv ? `+${evPct}% EV` : `${evPct}% EV`}
        </span>

        {/* Odds */}
        <span className="rounded bg-surface-module px-2.5 py-1 font-telemetry text-xs font-bold text-accent-cyan border border-border-hairline">
          {formattedOdds}
        </span>

        {/* Score */}
        <div className="flex flex-col items-center justify-center rounded bg-surface-module px-2 py-0.5 border border-border-hairline min-w-[46px]">
          <span className="text-[8px] uppercase tracking-wider text-text-muted font-bold">
            Score
          </span>
          <span className="font-telemetry text-xs font-bold text-accent-violet">
            {candidate.hybridValueScore}
          </span>
        </div>

        {/* 1-Click Swap Action Button */}
        <button
          type="button"
          onClick={onSelect}
          className="rounded-lg bg-accent-cyan px-3.5 py-1.5 font-sans text-xs font-bold uppercase tracking-wider text-surface-canvas hover:bg-cyan-400 active:scale-95 transition-all shadow-[0_0_10px_rgba(6,182,212,0.25)] cursor-pointer"
        >
          Select
        </button>
      </div>
    </div>
  );
}
