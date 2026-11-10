"use client";

import React, { useState } from "react";
import { useParlayDrawer } from "@/context/ParlayDrawerContext";
import type { ParlayLeg } from "@/types/parlay";

export function ParlayDrawer() {
  const {
    slip,
    isOpen,
    isDocked,
    swappedLegPropId,
    toastMessage,
    removeLeg,
    openSwapModal,
    setIsOpen,
    setIsDocked,
    clearSlip,
  } = useParlayDrawer();

  const [isLaunching, setIsLaunching] = useState(false);
  const [launchSuccess, setLaunchSuccess] = useState(false);

  const legCount = slip.legs.length;

  const formattedAmericanOdds =
    slip.combinedAmericanOdds > 0
      ? `+${slip.combinedAmericanOdds}`
      : `${slip.combinedAmericanOdds}`;

  const evPct = (parseFloat(slip.combinedEv) * 100).toFixed(1);
  const isPositiveEv = parseFloat(slip.combinedEv) > 0;

  const handleQuickPick = () => {
    if (!slip.isValidParlay) return;
    setIsLaunching(true);
    setTimeout(() => {
      setIsLaunching(false);
      setLaunchSuccess(true);
      setTimeout(() => setLaunchSuccess(false), 3000);
    }, 600);
  };

  return (
    <>
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 rounded-lg bg-accent-amber px-4 py-2 font-sans text-xs font-bold text-surface-canvas shadow-xl animate-bounce">
          {toastMessage}
        </div>
      )}

      {/* QuickPick Launch Toast - Staggered vertically to prevent collision */}
      {launchSuccess && (
        <div className="fixed top-16 right-5 z-50 rounded-lg bg-accent-emerald px-4 py-2 font-sans text-xs font-bold text-surface-canvas shadow-xl">
          ⚡ Staging {legCount}-leg parlay ticket into Sportsbook via QuickPick!
        </div>
      )}

      {/* ========================================================================= */}
      {/* DESKTOP RAIL (>= 1280px / xl:block)                                      */}
      {/* ========================================================================= */}
      <aside
        className={`hidden xl:flex w-[360px] shrink-0 flex-col rounded-xl border border-border-hairline bg-surface-card p-5 shadow-2xl transition-all duration-200 self-start sticky top-6 ${
          !isOpen && legCount === 0 ? "opacity-80" : ""
        }`}
        aria-label="Parlay Slip Drawer"
      >
        <DrawerContent
          slip={slip}
          legCount={legCount}
          formattedAmericanOdds={formattedAmericanOdds}
          evPct={evPct}
          isPositiveEv={isPositiveEv}
          swappedLegPropId={swappedLegPropId}
          isLaunching={isLaunching}
          onRemoveLeg={removeLeg}
          onSwapLeg={openSwapModal}
          onClearSlip={clearSlip}
          onQuickPick={handleQuickPick}
        />
      </aside>

      {/* ========================================================================= */}
      {/* MOBILE & TABLET BOTTOM BAR / SHEET (< 1280px)                            */}
      {/* ========================================================================= */}
      <div className="xl:hidden">
        {/* Docked Sticky Bottom Bar when collapsed */}
        {legCount > 0 && isDocked && (
          <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-between border-t border-border-hairline bg-surface-card/95 px-4 py-3 backdrop-blur-md shadow-2xl">
            <button
              type="button"
              onClick={() => {
                setIsDocked(false);
                setIsOpen(true);
              }}
              className="flex items-center gap-3 cursor-pointer text-left"
            >
              <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-accent-cyan font-telemetry text-xs font-bold text-surface-canvas">
                {legCount}
              </div>
              <div>
                <p className="font-display text-sm font-bold text-text-primary">
                  Parlay Slip ({legCount}/8 Legs)
                </p>
                <p className="text-[11px] text-text-muted">
                  {slip.isValidParlay ? "Ready to launch" : "Requires 2+ legs"}
                </p>
              </div>
            </button>

            <div className="flex items-center gap-2">
              {slip.isValidParlay && (
                <div className="flex items-center gap-1.5">
                  {slip.hasPositiveSynergy && (
                    <span className="rounded bg-accent-violet/20 px-1.5 py-0.5 text-[10px] font-bold text-accent-violet border border-accent-violet/30">
                      ⚡ Boost
                    </span>
                  )}
                  <span className="rounded bg-surface-module px-2.5 py-1 font-telemetry text-sm font-bold text-accent-violet border border-accent-violet/30">
                    {formattedAmericanOdds}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setIsDocked(false);
                  setIsOpen(true);
                }}
                className="rounded-lg bg-accent-cyan px-3 py-1.5 font-sans text-xs font-bold uppercase text-surface-canvas cursor-pointer shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              >
                Expand Slip ▲
              </button>
            </div>
          </div>
        )}

        {/* Expanded Bottom Sheet */}
        {legCount > 0 && !isDocked && isOpen && (
          <div className="fixed inset-0 z-50 flex flex-col justify-end bg-surface-canvas/80 backdrop-blur-sm">
            <div className="relative max-h-[85vh] w-full overflow-hidden rounded-t-2xl border-t border-border-hairline bg-surface-card p-5 shadow-2xl flex flex-col">
              {/* Mobile Sheet Handle / Header */}
              <div className="flex items-center justify-between border-b border-border-hairline pb-4 mb-4">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-8 rounded-full bg-border-hairline self-center mx-auto" />
                  <span className="font-display text-base font-bold text-text-primary">
                    Parlay Slip ({legCount}/8 Legs)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDocked(true)}
                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-primary bg-surface-module border border-border-hairline cursor-pointer"
                >
                  Collapse ▼
                </button>
              </div>

              {/* Drawer Content */}
              <div className="overflow-y-auto flex-1">
                <DrawerContent
                  slip={slip}
                  legCount={legCount}
                  formattedAmericanOdds={formattedAmericanOdds}
                  evPct={evPct}
                  isPositiveEv={isPositiveEv}
                  swappedLegPropId={swappedLegPropId}
                  isLaunching={isLaunching}
                  onRemoveLeg={removeLeg}
                  onSwapLeg={openSwapModal}
                  onClearSlip={clearSlip}
                  onQuickPick={handleQuickPick}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

interface DrawerContentProps {
  slip: ReturnType<typeof useParlayDrawer>["slip"];
  legCount: number;
  formattedAmericanOdds: string;
  evPct: string;
  isPositiveEv: boolean;
  swappedLegPropId: string | null;
  isLaunching: boolean;
  onRemoveLeg: (propId: string) => void;
  onSwapLeg: (leg: ParlayLeg) => void;
  onClearSlip: () => void;
  onQuickPick: () => void;
}

function DrawerContent({
  slip,
  legCount,
  formattedAmericanOdds,
  evPct,
  isPositiveEv,
  swappedLegPropId,
  isLaunching,
  onRemoveLeg,
  onSwapLeg,
  onClearSlip,
  onQuickPick,
}: DrawerContentProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Drawer Header */}
      <header className="flex items-start justify-between border-b border-border-hairline pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-surface-module px-2 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-wider text-accent-cyan border border-border-hairline">
              Active Slip
            </span>
            <span className="font-telemetry text-xs text-text-muted">
              {legCount}/8 Legs
            </span>
          </div>
          <h2 className="mt-1 font-display text-lg font-bold text-text-primary">
            Custom Parlay
          </h2>
        </div>

        {legCount > 0 && (
          <button
            type="button"
            onClick={onClearSlip}
            className="text-xs text-text-muted hover:text-accent-rose transition-colors cursor-pointer"
          >
            Clear All
          </button>
        )}
      </header>

      {/* SGP Correlation Boost Badge & Telemetry */}
      {slip.isSameGameParlay && (
        <div className="flex flex-col gap-2">
          {slip.hasPositiveSynergy ? (
            <div className="flex flex-col gap-1.5 rounded-lg bg-accent-violet/15 p-3 border border-accent-violet/40 text-accent-violet shadow-[0_0_12px_rgba(99,102,241,0.25)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-xs">⚡ Correlated Boost</span>
                  <span className="text-[10px] text-accent-emerald font-semibold font-telemetry">
                    (+EV Synergy)
                  </span>
                </div>
                {slip.sgpFairProbability && (
                  <span className="font-telemetry text-[11px] font-bold text-accent-cyan">
                    Fair P: {(parseFloat(slip.sgpFairProbability) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-muted">
                Intra-game synergy detected between correlated teammates.
              </p>
              {/* Correlation Audit Breakdown */}
              {slip.sgpCorrelationAudit && slip.sgpCorrelationAudit.length > 0 && (
                <div className="mt-1 flex flex-col gap-1.5 border-t border-accent-violet/20 pt-1.5">
                  {slip.sgpCorrelationAudit.map((item, idx) => (
                    <div
                      key={`${item.legAPropId}-${item.legBPropId}-${item.correlationCoefficient}`}
                      className="flex flex-col gap-0.5 rounded bg-surface-card/60 p-1.5 text-[10px]"
                    >
                      <div className="flex items-center justify-between font-medium">
                        <span className="text-text-primary">
                          {item.legADescription && item.legBDescription
                            ? `${item.legADescription} + ${item.legBDescription}`
                            : `Leg Pair ${idx + 1}`}
                        </span>
                        <span
                          className={`font-telemetry font-bold ${
                            item.correlationCoefficient > 0
                              ? "text-accent-emerald"
                              : "text-accent-amber"
                          }`}
                        >
                          {item.correlationCoefficient > 0 ? "+" : ""}
                          {item.correlationCoefficient.toFixed(2)}
                        </span>
                      </div>
                      <span className="text-text-muted text-[10px] leading-tight">
                        {item.rationale}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1 rounded-lg bg-surface-module p-2.5 border border-border-hairline text-text-muted text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-text-muted">🔗 Same-Game Parlay</span>
                <span className="text-[10px] text-text-muted font-normal">
                  (Standard / Cannibalized)
                </span>
              </div>
              {slip.sgpCorrelationAudit && slip.sgpCorrelationAudit.length > 0 && (
                <div className="mt-1 flex flex-col gap-1 border-t border-border-hairline pt-1 text-[10px]">
                  {slip.sgpCorrelationAudit.map((item) => (
                    <div
                      key={`${item.legAPropId}-${item.legBPropId}-${item.correlationCoefficient}`}
                      className="flex items-center justify-between text-text-muted"
                    >
                      <span>{item.rationale}</span>
                      <span className="font-telemetry font-bold text-accent-amber">
                        {item.correlationCoefficient.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Legs List */}
      {legCount === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-text-muted">
          <div className="mb-2 text-2xl">📋</div>
          <p className="font-display text-sm font-semibold text-text-primary">
            Your slip is empty
          </p>
          <p className="mt-1 text-xs max-w-[240px]">
            Add legs directly from Curated Presets ("Customize Legs") or the Market Browser ("Add to Slip").
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {slip.legs.map((leg) => {
            const isSwapped = swappedLegPropId === leg.propId;
            return (
              <DrawerLegRow
                key={leg.propId}
                leg={leg}
                isSwapped={isSwapped}
                onRemove={() => onRemoveLeg(leg.propId)}
                onSwap={() => onSwapLeg(leg)}
              />
            );
          })}
        </div>
      )}

      {/* Combined Summary & Payout */}
      {legCount > 0 && (
        <div className="mt-2 flex flex-col gap-3 rounded-xl bg-surface-module p-4 border border-border-hairline">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Combined Odds
            </span>
            <span className="font-telemetry text-base font-bold text-accent-violet">
              {slip.isValidParlay ? formattedAmericanOdds : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Decimal Multiple:</span>
            <span className="font-telemetry font-bold text-text-primary">
              {slip.isValidParlay ? `${parseFloat(slip.combinedDecimalOdds).toFixed(2)}x` : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Fair Probability:</span>
            <span className="font-telemetry font-bold text-text-primary">
              {slip.isValidParlay
                ? `${(parseFloat(slip.combinedFairProbability) * 100).toFixed(2)}%`
                : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">Devigged Fair EV:</span>
            <span
              className={`font-telemetry font-bold ${
                isPositiveEv ? "text-accent-emerald" : "text-text-muted"
              }`}
            >
              {slip.isValidParlay ? (isPositiveEv ? `+${evPct}%` : `${evPct}%`) : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between border-t border-border-hairline/60 pt-2 text-xs">
            <span className="text-text-muted">Hybrid Value Score:</span>
            <span className="font-telemetry font-bold text-accent-cyan">
              {slip.isValidParlay ? `Score ${slip.hybridValueScore}` : "—"}
            </span>
          </div>

          {/* Validation Notice when legs < 2 */}
          {!slip.isValidParlay && (
            <p className="rounded bg-accent-amber/10 p-2 text-center text-xs font-semibold text-accent-amber border border-accent-amber/30">
              Add at least 2 legs to complete parlay
            </p>
          )}

          {/* QuickPick Staging Button */}
          <button
            type="button"
            disabled={!slip.isValidParlay || isLaunching}
            onClick={onQuickPick}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent-cyan px-4 py-3 font-sans text-xs font-bold uppercase tracking-wider text-surface-canvas hover:bg-cyan-400 active:scale-[0.98] transition-all shadow-[0_0_15px_rgba(6,182,212,0.35)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLaunching ? (
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface-canvas border-t-transparent" />
            ) : (
              <span>⚡ Open in Sportsbook via QuickPick</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function DrawerLegRow({
  leg,
  isSwapped,
  onRemove,
  onSwap,
}: {
  leg: ParlayLeg;
  isSwapped: boolean;
  onRemove: () => void;
  onSwap: () => void;
}) {
  const formattedOdds =
    leg.offeredAmericanOdds > 0
      ? `+${leg.offeredAmericanOdds}`
      : `${leg.offeredAmericanOdds}`;

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-lg p-3 transition-all duration-300 ${
        isSwapped
          ? "ring-2 ring-accent-emerald bg-accent-emerald/15 shadow-[0_0_15px_rgba(16,185,129,0.35)]"
          : "bg-surface-module border border-border-hairline hover:border-accent-cyan/30"
      }`}
    >
      {/* Top Row: Details & Remove Action */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="font-sans text-xs font-bold text-text-primary">
              {leg.playerName}
            </span>
            <span className="text-[11px] text-text-muted">· {leg.teamAbbreviation}</span>
          </div>
          <p className="text-[11px] font-medium text-accent-cyan">
            {leg.marketDisplay}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded bg-surface-card px-2 py-0.5 font-telemetry text-xs font-bold text-accent-cyan border border-border-hairline">
            {formattedOdds}
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-xs text-text-muted hover:bg-surface-card hover:text-accent-rose transition-colors cursor-pointer"
            title="Remove leg from slip"
            aria-label={`Remove ${leg.playerName} leg`}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Middle Row: Form & Weather */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
        <div className="flex flex-wrap items-center gap-1.5">
          {leg.sofascoreForm && (
            <div className="flex items-center gap-0.5">
              {leg.sofascoreForm.map((hit, idx) => (
                <span
                  key={idx}
                  className={`h-2 w-2 rounded-[2px] ${
                    hit ? "bg-accent-emerald" : "bg-accent-rose"
                  }`}
                />
              ))}
            </div>
          )}
          {leg.hitRateDisplay && (
            <span className="font-telemetry font-medium">
              {leg.hitRateDisplay}
            </span>
          )}
          {/* Weather Context Badge */}
          {leg.weatherBadge && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium border ${
                leg.weatherBadge.isThreat
                  ? "bg-accent-amber/10 text-accent-amber border-accent-amber/30"
                  : "bg-surface-card text-text-muted border-border-hairline"
              }`}
            >
              {leg.weatherBadge.summary}
            </span>
          )}
        </div>

        {/* Swap Leg Button */}
        <button
          type="button"
          onClick={onSwap}
          className="rounded bg-surface-card px-2 py-1 font-sans text-[11px] font-semibold text-text-muted hover:text-accent-cyan hover:border-accent-cyan/40 border border-border-hairline transition-all cursor-pointer"
        >
          ⇄ Swap Leg
        </button>
      </div>
    </div>
  );
}
