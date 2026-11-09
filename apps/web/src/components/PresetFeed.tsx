"use client";

import React, { useEffect, useState } from "react";
import type { PresetCard as PresetCardType } from "@/types/preset";
import { recalculatePresetCard } from "@/lib/math";
import { PresetCard } from "./PresetCard";

interface PresetFeedProps {
  initialCards: PresetCardType[];
}

export function PresetFeed({ initialCards }: PresetFeedProps) {
  const [cards, setCards] = useState<PresetCardType[]>(initialCards);
  const [activeSportFilter, setActiveSportFilter] = useState<"all" | "nfl" | "nba">("all");
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);

  // Filter cards by sport
  const filteredCards = cards.filter((card) => {
    if (activeSportFilter === "all") return true;
    return card.sportKey === activeSportFilter;
  });

  // Subscribe to SSE /api/stream/odds for live odds adjustments
  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      return;
    }

    let eventSource: EventSource | null = null;
    let isMounted = true;

    try {
      eventSource = new EventSource("/api/stream/odds?sport=all");

      eventSource.addEventListener("open", () => {
        if (isMounted) {
          setSseConnected(true);
        }
      });

      eventSource.addEventListener("odds_delta", (event) => {
        if (!isMounted) return;
        try {
          const delta = JSON.parse(event.data);
          if (delta && delta.propId && delta.decimalOdds) {
            const newOdds = parseFloat(delta.decimalOdds);
            setCards((prevCards) =>
              prevCards.map((c) => recalculatePresetCard(c, delta.propId, newOdds))
            );
            setLastTickTime(new Date().toLocaleTimeString());
          }
        } catch {
          // Ignore malformed SSE frames
        }
      });

      eventSource.addEventListener("error", () => {
        if (isMounted) {
          setSseConnected(false);
        }
      });
    } catch {
      // EventSource failed
    }

    return () => {
      isMounted = false;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  return (
    <div>
      {/* Feed Controls & Telemetry Indicator */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Sport Filter Chips */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveSportFilter("all")}
            className={`rounded-lg px-3 py-1.5 font-sans text-xs font-semibold transition-all cursor-pointer ${
              activeSportFilter === "all"
                ? "bg-accent-cyan text-surface-canvas shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
            }`}
          >
            All Slates
          </button>
          <button
            type="button"
            onClick={() => setActiveSportFilter("nfl")}
            className={`rounded-lg px-3 py-1.5 font-sans text-xs font-semibold transition-all cursor-pointer ${
              activeSportFilter === "nfl"
                ? "bg-accent-cyan text-surface-canvas shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
            }`}
          >
            🏈 NFL
          </button>
          <button
            type="button"
            onClick={() => setActiveSportFilter("nba")}
            className={`rounded-lg px-3 py-1.5 font-sans text-xs font-semibold transition-all cursor-pointer ${
              activeSportFilter === "nba"
                ? "bg-accent-cyan text-surface-canvas shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
            }`}
          >
            🏀 NBA
          </button>
        </div>

        {/* Live SSE Telemetry Readout */}
        <div className="flex items-center gap-2 text-xs font-telemetry">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              sseConnected
                ? "bg-accent-emerald animate-pulse"
                : "bg-text-muted/50"
            }`}
          />
          <span className="text-text-muted">
            {sseConnected ? "SSE Odds Stream Live" : "Polling Telemetry"}
          </span>
          {lastTickTime && (
            <span className="text-[11px] text-accent-cyan">· {lastTickTime}</span>
          )}
        </div>
      </div>

      {/* Preset Cards Grid */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {filteredCards.map((card) => (
          <PresetCard key={card.presetId} card={card} />
        ))}
      </div>
    </div>
  );
}
