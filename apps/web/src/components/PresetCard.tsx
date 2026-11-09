"use client";

import React, { useState } from "react";
import type { PresetCard as PresetCardType, PresetLeg } from "@/types/preset";

interface PresetCardProps {
  card: PresetCardType;
  onCustomize?: (card: PresetCardType) => void;
  onQuickPick?: (card: PresetCardType) => void;
}

export function PresetCard({ card, onCustomize, onQuickPick }: PresetCardProps) {
  const [isLaunching, setIsLaunching] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const formattedAmericanOdds =
    card.combinedAmericanOdds > 0
      ? `+${card.combinedAmericanOdds}`
      : `${card.combinedAmericanOdds}`;

  const evPct = (parseFloat(card.combinedEv) * 100).toFixed(1);
  const isPositiveEv = parseFloat(card.combinedEv) > 0;

  const handleQuickPickClick = () => {
    setIsLaunching(true);
    if (onQuickPick) {
      onQuickPick(card);
    }
    setTimeout(() => {
      setIsLaunching(false);
      setToastMessage(`Slip staged for QuickPick: ${card.title}`);
      setTimeout(() => setToastMessage(null), 3000);
    }, 600);
  };

  return (
    <article className="relative flex flex-col justify-between rounded-xl bg-surface-card p-5 border border-border-hairline hover:border-accent-cyan/40 transition-all duration-200 shadow-lg">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-20 rounded-md bg-accent-emerald px-3 py-1 font-sans text-xs font-bold text-surface-canvas shadow-md">
          {toastMessage}
        </div>
      )}

      <div>
        {/* Card Header */}
        <header className="flex items-start justify-between gap-2 border-b border-border-hairline pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-surface-module px-2 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-wider text-accent-cyan border border-border-hairline">
                {card.themeBadge}
              </span>
              <span className="rounded bg-surface-module px-2 py-0.5 font-telemetry text-xs font-bold text-accent-cyan border border-border-hairline">
                Score {card.hybridValueScore}
              </span>
            </div>
            <h3 className="mt-2 font-display text-[20px] leading-[26px] font-semibold text-text-primary">
              {card.title}
            </h3>
          </div>

          <div className="flex flex-col items-end gap-1">
            <span className="rounded-lg bg-surface-module px-3 py-1 font-telemetry text-[18px] leading-[22px] font-bold text-accent-violet border border-accent-violet/30 shadow-[0_0_12px_rgba(99,102,241,0.25)]">
              {formattedAmericanOdds}
            </span>
            <span
              className={`rounded px-2 py-0.5 font-telemetry text-[11px] font-bold border border-border-hairline ${
                isPositiveEv
                  ? "bg-surface-module text-accent-emerald"
                  : "bg-surface-module text-text-muted"
              }`}
            >
              {isPositiveEv ? `+${evPct}% EV` : `${evPct}% EV`}
            </span>
          </div>
        </header>

        {/* Legs List */}
        <div className="mt-4 flex flex-col divide-y divide-border-hairline/60">
          {card.legs.map((leg) => (
            <PresetLegRow key={leg.propId} leg={leg} />
          ))}
        </div>
      </div>

      {/* Card Footer Actions */}
      <footer className="mt-6 flex items-center gap-3 border-t border-border-hairline pt-4">
        <button
          type="button"
          onClick={() => onCustomize && onCustomize(card)}
          className="rounded-lg border border-border-hairline bg-surface-module px-3.5 py-2.5 font-sans text-xs font-semibold text-text-muted hover:border-text-muted/40 hover:text-text-primary transition-colors cursor-pointer"
        >
          Customize Legs
        </button>

        <button
          type="button"
          disabled={isLaunching}
          onClick={handleQuickPickClick}
          className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-accent-cyan px-4 py-2.5 font-sans text-xs font-bold uppercase tracking-wider text-surface-canvas hover:bg-cyan-400 active:scale-[0.98] transition-all duration-150 shadow-[0_0_15px_rgba(6,182,212,0.35)] cursor-pointer disabled:opacity-50"
        >
          {isLaunching ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface-canvas border-t-transparent" />
          ) : (
            <span>⚡ Open in Sportsbook via QuickPick</span>
          )}
        </button>
      </footer>
    </article>
  );
}

function PresetLegRow({ leg }: { leg: PresetLeg }) {
  const sharpOddsStr = leg.sharpAmericanOdds
    ? leg.sharpAmericanOdds > 0
      ? `+${leg.sharpAmericanOdds}`
      : `${leg.sharpAmericanOdds}`
    : null;

  return (
    <div className="py-3 first:pt-1 last:pb-1">
      <div className="flex items-start justify-between gap-3">
        {/* Player Avatar & Details */}
        <div className="flex items-start gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-module border border-border-hairline font-display text-xs font-bold text-text-primary">
            {leg.playerName
              .split(" ")
              .map((n) => n[0])
              .join("")
              .slice(0, 2)}
            <span className="absolute -bottom-1 -right-1 rounded bg-surface-card px-1 py-0.2 text-[9px] font-bold text-accent-cyan border border-border-hairline">
              {leg.teamAbbreviation}
            </span>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-sans text-sm font-semibold text-text-primary">
                {leg.playerName}
              </span>
              <span className="text-xs text-text-muted">· {leg.matchup}</span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded bg-surface-module px-2 py-0.5 text-[11px] font-medium text-accent-cyan border border-border-hairline">
                {leg.marketDisplay}
              </span>

              {/* Weather Context Badge */}
              {leg.weatherBadge && (
                <span
                  className={`rounded px-1.5 py-0.5 font-sans text-[11px] font-medium border ${
                    leg.weatherBadge.isThreat
                      ? "bg-accent-amber/10 text-accent-amber border-accent-amber/30"
                      : "bg-surface-module text-text-muted border-border-hairline"
                  }`}
                >
                  {leg.weatherBadge.summary}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Sharp Price Pill */}
        {sharpOddsStr && (
          <span className="shrink-0 rounded bg-surface-module px-2 py-0.5 font-telemetry text-xs font-medium text-text-muted border border-border-hairline">
            ✓ {sharpOddsStr}
          </span>
        )}
      </div>

      {/* Conviction Micro-Copy */}
      <p className="mt-2 text-xs leading-4.5 text-text-muted font-sans italic">
        "{leg.convictionRationale}"
      </p>

      {/* Sofascore Form Indicator */}
      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex items-center gap-1" title="Last 5 Games Form (oldest to newest)">
          {leg.sofascoreForm.map((hit, idx) => (
            <span
              key={idx}
              className={`h-2.5 w-2.5 rounded-[3px] ${
                hit ? "bg-accent-emerald" : "bg-accent-rose"
              }`}
            />
          ))}
        </div>
        <span className="font-telemetry text-[11px] font-medium text-text-muted">
          {leg.hitRateDisplay}
        </span>
      </div>
    </div>
  );
}
