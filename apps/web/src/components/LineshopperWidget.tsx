"use client";

import React from "react";
import type { ParlayLeg } from "@/types/parlay";
import {
  type LineshopperComparisonResult,
  type SportsbookId,
} from "@/types/lineshopper";
import { compareMultiBookOdds } from "@/lib/lineshopper";

export interface LineshopperWidgetProps {
  legs: ParlayLeg[];
  comparison?: LineshopperComparisonResult;
  selectedSportsbook: SportsbookId;
  onSelectSportsbook: (sportsbookId: SportsbookId) => void;
  className?: string;
}

export function LineshopperWidget({
  legs,
  comparison: propsComparison,
  selectedSportsbook,
  onSelectSportsbook,
  className = "",
}: LineshopperWidgetProps) {
  const comparison =
    propsComparison ??
    compareMultiBookOdds(legs, {
      selectedSportsbook,
    });

  const legCount = legs.length;

  if (legCount === 0) {
    return (
      <div
        className={`flex flex-col gap-2 rounded-xl bg-surface-module/70 p-3.5 border border-border-hairline text-center ${className}`}
      >
        <div className="flex items-center justify-between text-xs font-semibold text-text-muted">
          <span className="flex items-center gap-1.5 text-text-primary">
            <span>⇄</span> Lineshopper Odds Comparison
          </span>
          <span className="font-telemetry text-[10px] text-accent-emerald font-semibold">
            LIVE
          </span>
        </div>
        <p className="text-xs text-text-muted py-2">
          Add 2+ legs to compare parlay lines across sportsbooks
        </p>
      </div>
    );
  }

  const isSingleLeg = legCount === 1;

  return (
    <div
      className={`flex flex-col gap-2.5 rounded-xl bg-surface-module p-3.5 border border-border-hairline shadow-md ${className}`}
      aria-label="Multi-Sportsbook Lineshopper"
    >
      {/* Widget Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-accent-cyan">⇄</span>
          <span className="font-sans text-xs font-bold text-text-primary">
            Lineshopper Odds Comparison
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-telemetry text-[10px] font-bold text-accent-emerald bg-accent-emerald/10 px-1.5 py-0.5 rounded border border-accent-emerald/20">
            LIVE
          </span>
          <span className="text-[10px] text-text-muted">
            {isSingleLeg ? "Single Prop Line" : `${legCount} Legs`}
          </span>
        </div>
      </div>

      {/* Best Value Advantage Banner */}
      {!isSingleLeg && comparison.bestValueBookId && comparison.edgeDescription && (
        <div className="flex items-center justify-between rounded-lg bg-accent-emerald/10 px-2.5 py-1.5 border border-accent-emerald/30 text-accent-emerald">
          <span className="text-[11px] font-semibold">Top Payout Advantage</span>
          <span className="font-telemetry text-[11px] font-bold">
            {comparison.edgeDescription}
          </span>
        </div>
      )}

      {/* Sportsbook Cards List */}
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Select Sportsbook">
        {comparison.bookmakerList.map((book) => {
          const isSelected = selectedSportsbook === book.sportsbookId;
          const isBest = book.isBestValue;
          const isAvailable = book.isAvailable;

          let cardStyle =
            "relative flex items-center justify-between rounded-lg p-2.5 border transition-all cursor-pointer ";

          if (!isAvailable) {
            cardStyle +=
              "bg-surface-card/40 border-dashed border-border-hairline opacity-50 cursor-not-allowed";
          } else if (isSelected) {
            cardStyle +=
              "bg-surface-card border-accent-cyan ring-2 ring-accent-cyan shadow-[0_0_12px_rgba(6,182,212,0.25)]";
          } else if (isBest) {
            cardStyle +=
              "bg-surface-card border-accent-emerald hover:border-accent-emerald/80 shadow-[0_0_10px_rgba(16,185,129,0.15)]";
          } else {
            cardStyle +=
              "bg-surface-card border-border-hairline hover:border-border-hairline/90 hover:bg-surface-card/80";
          }

          return (
            <div
              key={book.sportsbookId}
              role="radio"
              aria-checked={isSelected}
              aria-disabled={!isAvailable}
              tabIndex={isAvailable ? 0 : -1}
              onClick={() => {
                if (isAvailable) {
                  onSelectSportsbook(book.sportsbookId);
                }
              }}
              onKeyDown={(e) => {
                if (isAvailable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelectSportsbook(book.sportsbookId);
                }
              }}
              className={cardStyle}
            >
              {/* Left Column: Brand Icon, Name, and Best Value Badge */}
              <div className="flex items-center gap-2">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded font-telemetry text-[10px] font-bold text-surface-canvas"
                  style={{ backgroundColor: book.accentColor || book.brandColor }}
                >
                  {book.shortName}
                </span>

                <div className="flex items-center gap-1.5">
                  <span
                    className={`font-sans text-xs ${
                      isSelected || isBest ? "font-bold text-text-primary" : "text-text-muted"
                    }`}
                  >
                    {book.name}
                  </span>

                  {isBest && isAvailable && (
                    <span className="rounded bg-accent-emerald/15 px-1.5 py-0.2 text-[9px] font-bold text-accent-emerald border border-accent-emerald/30 font-telemetry">
                      Best Value ⭐
                    </span>
                  )}
                </div>
              </div>

              {/* Right Column: Odds & Edge or Missing notice */}
              <div className="text-right">
                {isAvailable ? (
                  <div className="flex flex-col items-end">
                    <span
                      className={`font-telemetry text-xs font-bold ${
                        isBest ? "text-accent-emerald" : isSelected ? "text-accent-cyan" : "text-text-primary"
                      }`}
                    >
                      {book.formattedAmericanOdds}
                    </span>
                    {isBest && Math.round(comparison.dollarEdge) >= 1 && (
                      <span className="font-telemetry text-[10px] font-semibold text-accent-emerald">
                        +${Math.round(comparison.dollarEdge)} Edge
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="rounded bg-surface-module px-1.5 py-0.5 text-[10px] font-medium text-text-muted border border-border-hairline">
                    {book.missingLegCount > 0
                      ? `Unavailable (${book.missingLegCount} missing)`
                      : "Unavailable"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
