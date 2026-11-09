"use client";

import React, { useState } from "react";
import type { PresetCard as PresetCardType } from "@/types/preset";
import type { MarketBrowserFeed as MarketBrowserFeedType } from "@/types/market";
import { PresetFeed } from "@/components/PresetFeed";
import { MarketBrowser } from "@/components/MarketBrowser";

interface TerminalViewProps {
  initialPresets: PresetCardType[];
  initialMarketFeed: MarketBrowserFeedType;
}

export function TerminalView({
  initialPresets,
  initialMarketFeed,
}: TerminalViewProps) {
  const [activeTab, setActiveTab] = useState<"presets" | "browser">("presets");

  return (
    <div>
      {/* Top Navigation Tabs */}
      <nav className="mb-8 flex items-center gap-3 border-b border-border-hairline pb-4">
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
      </nav>

      {/* Main Content Area */}
      {activeTab === "presets" ? (
        <PresetFeed initialCards={initialPresets} />
      ) : (
        <MarketBrowser initialFeed={initialMarketFeed} />
      )}
    </div>
  );
}
