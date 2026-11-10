import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { TerminalView } from "./TerminalView";
import { saveTrackedBet } from "@/lib/ledger";
import type { PresetCard } from "@/types/preset";
import type { MarketBrowserFeed } from "@/types/market";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("TerminalView navigation and My Bets tab integration", () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal("localStorage", mockStorage);
  });

  const dummyPresets: PresetCard[] = [];
  const dummyMarketFeed: MarketBrowserFeed = {
    generatedAt: new Date().toISOString(),
    sportKey: "all",
    games: [],
    props: [],
  };

  it("renders the '🎫 My Bets' navigation tab with badge count", () => {
    saveTrackedBet({
      betId: "b1",
      userId: "u1",
      sportsbook: "DraftKings",
      decimalOdds: 2.0,
      americanOdds: 100,
      stakeAmount: 50,
      potentialPayout: 100,
      status: "staged",
      legs: [],
    });

    const markup = renderToStaticMarkup(
      <TerminalView
        initialPresets={dummyPresets}
        initialMarketFeed={dummyMarketFeed}
      />,
    );

    expect(markup).toContain("🎫 My Bets");
    expect(markup).toContain("⚡ Curated Presets");
    expect(markup).toContain("📊 Schedule &amp; Market Browser");
  });
});
