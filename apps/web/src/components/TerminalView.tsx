"use client";

import React, { useState, useEffect } from "react";
import type { PresetCard as PresetCardType } from "@/types/preset";
import type { MarketBrowserFeed as MarketBrowserFeedType } from "@/types/market";
import { ParlayDrawerProvider } from "@/context/ParlayDrawerContext";
import { PresetFeed } from "@/components/PresetFeed";
import { MarketBrowser } from "@/components/MarketBrowser";
import { ParlayDrawer } from "@/components/ParlayDrawer";
import { LegSwapperModal } from "@/components/LegSwapperModal";
import { BetTrackerDashboard } from "@/components/BetTrackerDashboard";
import { getTrackedBets } from "@/lib/ledger";

interface TerminalViewProps {
  initialPresets: PresetCardType[];
  initialMarketFeed: MarketBrowserFeedType;
}

export function TerminalView({
  initialPresets,
  initialMarketFeed,
}: TerminalViewProps) {
  const [activeTab, setActiveTab] = useState<"presets" | "browser" | "bets">("presets");
  const [myBetsCount, setMyBetsCount] = useState<number>(0);

  useEffect(() => {
    const updateCount = () => {
      try {
        const bets = getTrackedBets();
        setMyBetsCount(bets.length);
      } catch {
        setMyBetsCount(0);
      }
    };

    updateCount();
    window.addEventListener("storage", updateCount);
    window.addEventListener("focus", updateCount);
    window.addEventListener("parlaypal:bets_updated", updateCount);
    return () => {
      window.removeEventListener("storage", updateCount);
      window.removeEventListener("focus", updateCount);
      window.removeEventListener("parlaypal:bets_updated", updateCount);
    };
  }, []);

  return (
    <ParlayDrawerProvider initialCandidates={initialMarketFeed.props}>
      <div className="flex flex-col xl:flex-row gap-8 items-start">
        {/* Main Center Content Canvas */}
        <div className="flex-1 min-w-0 w-full">
          {/* Top Navigation Tabs */}
          <nav className="mb-8 flex flex-wrap items-center gap-3 border-b border-border-hairline pb-4">
            <button
              type="button"
              onClick={() => setActiveTab("presets")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 font-display text-sm font-semibold transition-all cursor-pointer ${
                activeTab === "presets"
                  ? "bg-accent-cyan text-surface-canvas shadow-[0_0_12px_rgba(6,182,212,0.35)]"
                  : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
              }`}
            >
              <span>⚡ Curated Presets</span>
              <span className="rounded bg-surface-canvas/20 px-1.5 py-0.2 text-[10px] font-telemetry">
                {initialPresets.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("browser")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 font-display text-sm font-semibold transition-all cursor-pointer ${
                activeTab === "browser"
                  ? "bg-accent-cyan text-surface-canvas shadow-[0_0_12px_rgba(6,182,212,0.35)]"
                  : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
              }`}
            >
              <span>📊 Schedule &amp; Market Browser</span>
              <span className="rounded bg-surface-canvas/20 px-1.5 py-0.2 text-[10px] font-telemetry">
                {initialMarketFeed.props.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("bets")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 font-display text-sm font-semibold transition-all cursor-pointer ${
                activeTab === "bets"
                  ? "bg-accent-cyan text-surface-canvas shadow-[0_0_12px_rgba(6,182,212,0.35)]"
                  : "bg-surface-module text-text-muted hover:text-text-primary border border-border-hairline"
              }`}
            >
              <span>🎫 My Bets</span>
              <span className="rounded bg-surface-canvas/20 px-1.5 py-0.2 text-[10px] font-telemetry">
                {myBetsCount}
              </span>
            </button>
          </nav>

          {/* Tab Content View */}
          {activeTab === "presets" ? (
            <PresetFeed initialCards={initialPresets} />
          ) : activeTab === "browser" ? (
            <MarketBrowser initialFeed={initialMarketFeed} />
          ) : (
            <BetTrackerDashboard onNavigate={setActiveTab} />
          )}
        </div>

        {/* Persistent Parlay Drawer (Desktop Right Rail & Mobile Bottom Sheet) */}
        <ParlayDrawer />
      </div>

      {/* Leg Swapper Modal */}
      <LegSwapperModal />
    </ParlayDrawerProvider>
  );
}
