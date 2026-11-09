"use client";

import React, { useEffect, useState } from "react";
import type {
  DateWindowFilter,
  MarketBrowserFeed as MarketBrowserFeedType,
  MarketFilter,
  MarketPropRow,
  SportFilter,
} from "@/types/market";
import {
  CANONICAL_MARKETS_BY_SPORT,
  filterMarketProps,
  recalculateMarketPropRow,
} from "@/lib/market-filters";
import { useParlayDrawer } from "@/context/ParlayDrawerContext";

interface MarketBrowserProps {
  initialFeed: MarketBrowserFeedType;
}

export function MarketBrowser({ initialFeed }: MarketBrowserProps) {
  const [props, setProps] = useState<MarketPropRow[]>(initialFeed.props);
  const [sport, setSport] = useState<SportFilter>("all");
  const [dateWindow, setDateWindow] = useState<DateWindowFilter>("all");
  const [market, setMarket] = useState<MarketFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);

  const { slip, addMarketProp, setCandidatePool } = useParlayDrawer();

  // Sync candidate pool to ParlayDrawerContext so leg swapper can surface alternatives
  useEffect(() => {
    setCandidatePool(props);
  }, [props, setCandidatePool]);

  // When sport changes, reset market to "all" if current market is not valid for selected sport
  const handleSportChange = (newSport: SportFilter) => {
    setSport(newSport);
    if (newSport !== "all" && market !== "all") {
      const valid = CANONICAL_MARKETS_BY_SPORT[newSport];
      if (!valid || !(market in valid)) {
        setMarket("all");
      }
    }
  };

  // Subscribe to live SSE updates for odds deltas
  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      return;
    }

    let eventSource: EventSource | null = null;
    let isMounted = true;

    try {
      eventSource = new EventSource("/api/stream/odds?sport=all");

      eventSource.addEventListener("open", () => {
        if (isMounted) setSseConnected(true);
      });

      const handleOddsUpdate = (rawMessage: string) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(rawMessage);
          // Support direct prop delta frame or quotes array in OddsDeltaFrame
          const deltas: { propId: string; newOdds: number }[] = [];
          if (payload.propId && payload.decimalOdds) {
            deltas.push({ propId: payload.propId, newOdds: parseFloat(payload.decimalOdds) });
          } else if (payload.prop_id && payload.decimal_odds) {
            deltas.push({ propId: payload.prop_id, newOdds: parseFloat(payload.decimal_odds) });
          } else if (Array.isArray(payload.quotes)) {
            for (const q of payload.quotes) {
              const pid = q.propId || q.prop_id;
              const odds = q.decimalOdds || q.decimal_odds;
              if (pid && odds) {
                deltas.push({ propId: pid, newOdds: parseFloat(odds) });
              }
            }
          }

          if (deltas.length > 0) {
            setProps((prev) => {
              const updated = prev.map((row) => {
                const match = deltas.find((d) => d.propId === row.propId);
                return match ? recalculateMarketPropRow(row, match.newOdds) : row;
              });
              // Re-sort to preserve invariant ranking: hybrid_value_score desc, guarded_ev desc
              return updated.sort((a, b) => {
                if (b.hybridValueScore !== a.hybridValueScore) {
                  return b.hybridValueScore - a.hybridValueScore;
                }
                return parseFloat(b.guardedEv) - parseFloat(a.guardedEv);
              });
            });
            setLastTickTime(new Date().toLocaleTimeString());
          }
        } catch {
          // Ignore frame parsing errors
        }
      };

      eventSource.onmessage = (event) => handleOddsUpdate(event.data);
      eventSource.addEventListener("odds_delta", (event) => handleOddsUpdate(event.data));

      eventSource.addEventListener("error", () => {
        if (isMounted) setSseConnected(false);
      });
    } catch {
      // EventSource instantiation failed
    }

    return () => {
      isMounted = false;
      if (eventSource) eventSource.close();
    };
  }, []);

  const visibleProps = filterMarketProps(props, {
    sport,
    dateWindow,
    market,
    query: searchQuery,
  });

  const availableMarkets: { key: string; label: string }[] =
    sport === "nfl"
      ? Object.entries(CANONICAL_MARKETS_BY_SPORT.nfl).map(([k, v]) => ({
          key: k,
          label: v,
        }))
      : sport === "nba"
        ? Object.entries(CANONICAL_MARKETS_BY_SPORT.nba).map(([k, v]) => ({
            key: k,
            label: v,
          }))
        : [
            ...Object.entries(CANONICAL_MARKETS_BY_SPORT.nfl).map(([k, v]) => ({
              key: k,
              label: `NFL ${v}`,
            })),
            ...Object.entries(CANONICAL_MARKETS_BY_SPORT.nba).map(([k, v]) => ({
              key: k,
              label: `NBA ${v}`,
            })),
          ];

  const slipPropIds = new Set(slip.legs.map((l) => l.propId));

  return (
    <div className="flex flex-col gap-6">
      {/* Filters Header Bar */}
      <div className="flex flex-col gap-4 rounded-xl bg-surface-module p-5 border border-border-hairline shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Sport Switcher Chips */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider mr-1">
              Sport:
            </span>
            {(["all", "nfl", "nba"] as SportFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleSportChange(s)}
                className={`rounded-lg px-3 py-1.5 font-sans text-xs font-semibold transition-all cursor-pointer ${
                  sport === s
                    ? "bg-accent-cyan text-surface-canvas shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                    : "bg-surface-card text-text-muted hover:text-text-primary border border-border-hairline"
                }`}
              >
                {s === "all" ? "All Sports" : s === "nfl" ? "🏈 NFL" : "🏀 NBA"}
              </button>
            ))}
          </div>

          {/* Date Window Chips */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider mr-1">
              Date:
            </span>
            {(["all", "today", "tomorrow", "weekend"] as DateWindowFilter[]).map(
              (dw) => (
                <button
                  key={dw}
                  type="button"
                  onClick={() => setDateWindow(dw)}
                  className={`rounded-lg px-3 py-1.5 font-sans text-xs font-semibold transition-all cursor-pointer ${
                    dateWindow === dw
                      ? "bg-accent-cyan text-surface-canvas shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                      : "bg-surface-card text-text-muted hover:text-text-primary border border-border-hairline"
                  }`}
                >
                  {dw === "all"
                    ? "All Slate"
                    : dw.charAt(0).toUpperCase() + dw.slice(1)}
                </button>
              ),
            )}
          </div>

          {/* Live Telemetry Indicator */}
          <div className="flex items-center gap-2 text-xs font-telemetry">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                sseConnected ? "bg-accent-emerald animate-pulse" : "bg-text-muted/50"
              }`}
            />
            <span className="text-text-muted">
              {sseConnected ? "Live SSE Stream" : "Static Telemetry"}
            </span>
            {lastTickTime && (
              <span className="text-[11px] text-accent-cyan">· {lastTickTime}</span>
            )}
          </div>
        </div>

        {/* Market Category Pills & Search Row */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border-hairline/60 pt-4">
          {/* Market Category Pills */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider mr-1">
              Prop:
            </span>
            <button
              type="button"
              onClick={() => setMarket("all")}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
                market === "all"
                  ? "bg-accent-violet text-text-primary shadow-[0_0_10px_rgba(99,102,241,0.3)]"
                  : "bg-surface-card text-text-muted hover:text-text-primary border border-border-hairline"
              }`}
            >
              All Props
            </button>
            {availableMarkets.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMarket(m.key as MarketFilter)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
                  market === m.key
                    ? "bg-accent-violet text-text-primary shadow-[0_0_10px_rgba(99,102,241,0.3)]"
                    : "bg-surface-card text-text-muted hover:text-text-primary border border-border-hairline"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative flex items-center min-w-[240px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search player, team, matchup..."
              className="w-full rounded-lg bg-surface-card px-3.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted border border-border-hairline focus:border-accent-cyan focus:outline-none transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 text-xs text-text-muted hover:text-text-primary cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Matchup Schedule Overview Badges */}
      {initialFeed.games.length > 0 && (
        <div className="flex items-center gap-3 overflow-x-auto pb-2 scrollbar-none">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted shrink-0">
            Upcoming Slate:
          </span>
          {initialFeed.games
            .filter(
              (g) =>
                (sport === "all" || g.sportKey === sport) &&
                (dateWindow === "all" || g.dateWindow === dateWindow),
            )
            .map((g) => (
            <div
              key={g.eventId}
              className="flex items-center gap-2 rounded-lg bg-surface-module px-3 py-1.5 border border-border-hairline shrink-0 text-xs"
            >
              <span className="font-semibold text-text-primary">{g.matchup}</span>
              <span className="rounded bg-surface-card px-1.5 py-0.5 text-[10px] text-accent-cyan font-telemetry">
                {g.propCount} props
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Props Screener Table / List */}
      <div className="rounded-xl bg-surface-card border border-border-hairline overflow-hidden shadow-lg">
        {visibleProps.length === 0 ? (
          <div className="p-12 text-center text-text-muted">
            <p className="font-display text-lg font-semibold text-text-primary">
              No matching player props found
            </p>
            <p className="mt-1 text-xs">
              Try adjusting your sport, date window, or prop market filters.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border-hairline/60">
            {visibleProps.map((prop) => (
              <MarketPropRowItem
                key={prop.propId}
                prop={prop}
                isInSlip={slipPropIds.has(prop.propId)}
                onAddToSlip={() => addMarketProp(prop)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketPropRowItem({
  prop,
  isInSlip,
  onAddToSlip,
}: {
  prop: MarketPropRow;
  isInSlip: boolean;
  onAddToSlip: () => void;
}) {
  const evPct = (parseFloat(prop.guardedEv) * 100).toFixed(1);
  const isPositiveEv = parseFloat(prop.guardedEv) > 0;
  const formattedOdds =
    prop.offeredAmericanOdds > 0
      ? `+${prop.offeredAmericanOdds}`
      : `${prop.offeredAmericanOdds}`;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between hover:bg-surface-module/40 transition-colors">
      {/* Left: Player, Matchup, Category */}
      <div className="flex items-start gap-3.5">
        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-module border border-border-hairline font-display text-xs font-bold text-text-primary">
          {prop.playerName
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)}
          <span className="absolute -bottom-1 -right-1 rounded bg-surface-card px-1 py-0.2 text-[9px] font-bold text-accent-cyan border border-border-hairline">
            {prop.teamAbbreviation}
          </span>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-sm font-bold text-text-primary">
              {prop.playerName}
            </span>
            <span className="text-xs text-text-muted">· {prop.matchup}</span>
            <span className="rounded bg-surface-module px-2 py-0.5 text-[11px] font-medium text-accent-cyan border border-border-hairline">
              {prop.marketDisplay}
            </span>
            {prop.isHighValue && (
              <span className="rounded bg-accent-emerald/15 px-2 py-0.5 text-[10px] font-bold text-accent-emerald border border-accent-emerald/30 uppercase tracking-wider">
                ★ High Value
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            {/* Sofascore Form Indicator */}
            <div className="flex items-center gap-1" title="L5 Form (oldest to newest)">
              {prop.sofascoreForm.map((hit, idx) => (
                <span
                  key={idx}
                  className={`h-2.5 w-2.5 rounded-[3px] ${
                    hit ? "bg-accent-emerald" : "bg-accent-rose"
                  }`}
                />
              ))}
            </div>
            <span className="font-telemetry text-xs font-medium text-text-muted">
              {prop.hitRateDisplay}
            </span>

            {/* Weather / Dome Badge */}
            {prop.weatherBadge && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium border ${
                  prop.weatherBadge.isThreat
                    ? "bg-accent-amber/10 text-accent-amber border-accent-amber/30"
                    : "bg-surface-module text-text-muted border-border-hairline"
                }`}
              >
                {prop.weatherBadge.summary}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right: Odds, EV, Hybrid Score, & Add to Slip */}
      <div className="flex items-center justify-between sm:justify-end gap-3 self-end sm:self-center">
        {/* Guarded EV */}
        <span
          className={`rounded px-2 py-1 font-telemetry text-xs font-bold border border-border-hairline ${
            isPositiveEv
              ? "bg-surface-module text-accent-emerald"
              : "bg-surface-module text-text-muted"
          }`}
        >
          {isPositiveEv ? `+${evPct}% EV` : `${evPct}% EV`}
        </span>

        {/* Offered American Odds */}
        <span className="rounded-lg bg-surface-module px-3 py-1 font-telemetry text-sm font-bold text-accent-cyan border border-border-hairline">
          {formattedOdds}
        </span>

        {/* Hybrid Value Score Pill */}
        <div className="flex flex-col items-center justify-center rounded-lg bg-surface-module px-2.5 py-1 border border-border-hairline min-w-[54px]">
          <span className="text-[9px] uppercase tracking-wider text-text-muted font-bold">
            Score
          </span>
          <span className="font-telemetry text-sm font-bold text-accent-violet">
            {prop.hybridValueScore}
          </span>
        </div>

        {/* Add to Slip / In Slip Action Button */}
        {isInSlip ? (
          <button
            type="button"
            disabled
            className="rounded-lg bg-surface-module px-3.5 py-2 font-sans text-xs font-semibold text-accent-emerald border border-accent-emerald/30 cursor-default"
          >
            ✓ In Slip
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddToSlip}
            className="rounded-lg bg-surface-module px-3.5 py-2 font-sans text-xs font-semibold text-accent-cyan hover:bg-accent-cyan hover:text-surface-canvas border border-border-hairline transition-all cursor-pointer shadow-sm active:scale-95"
          >
            + Add to Slip
          </button>
        )}
      </div>
    </div>
  );
}
