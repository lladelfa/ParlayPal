"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type {
  DateWindowFilter,
  MarketBrowserFeed as MarketBrowserFeedType,
  MarketFilter,
  MarketPropRow,
  ScheduledEventSummary,
  SportFilter,
} from "@/types/market";
import {
  CANONICAL_MARKETS_BY_SPORT,
  filterMarketProps,
  formatMoney,
  formatSpread,
  formatTotal,
  recalculateMarketPropRow,
} from "@/lib/market-filters";
import { useParlayDrawer } from "@/context/ParlayDrawerContext";

interface MarketBrowserProps {
  initialFeed: MarketBrowserFeedType;
}

/** Returns the id only if it names a game in the slate; otherwise null. */
export function resolveGameParam(
  games: ScheduledEventSummary[],
  id: string | null,
): string | null {
  if (!id) return null;
  return games.some((g) => g.eventId === id) ? id : null;
}

/** Sets or removes `game` in the query string, keeping other params and the hash. */
export function withGameParam(
  pathname: string,
  search: string,
  hash: string,
  gameId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (gameId) {
    params.set("game", gameId);
  } else {
    params.delete("game");
  }
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}

function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MainLinesGrid({ game }: { game: ScheduledEventSummary }) {
  const lines = game.lines;
  const rows = [
    {
      team: game.awayTeamAbbreviation,
      spread: formatSpread(lines?.spread?.away),
      money: formatMoney(lines?.moneyline?.away),
      total: formatTotal(lines?.total?.over, "O"),
    },
    {
      team: game.homeTeamAbbreviation,
      spread: formatSpread(lines?.spread?.home),
      money: formatMoney(lines?.moneyline?.home),
      total: formatTotal(lines?.total?.under, "U"),
    },
  ];

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[17rem] grid-cols-[3rem_1fr_1fr_1fr] gap-x-2 gap-y-1 font-telemetry text-xs">
        <span />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Spread</span>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Money</span>
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Total</span>
        {rows.map((r) => (
          <React.Fragment key={r.team}>
            <span className="font-semibold text-text-primary">{r.team}</span>
            <span className="text-text-primary">{r.spread}</span>
            <span className="text-text-primary">{r.money}</span>
            <span className="text-text-primary">{r.total}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export function SlateGameCard({
  game,
  selected,
  onSelect,
}: {
  game: ScheduledEventSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full min-w-0 flex-col gap-2 rounded-xl p-3 text-left transition-all cursor-pointer border ${
        selected
          ? "bg-surface-module border-accent-cyan shadow-[0_0_12px_rgba(6,182,212,0.3)]"
          : "bg-surface-card border-border-hairline hover:border-accent-cyan/50"
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-text-primary">{game.matchup}</span>
        <span className="flex items-center gap-2 shrink-0">
          <span
            className="text-[11px] text-text-muted font-telemetry"
            suppressHydrationWarning
          >
            {formatStart(game.commenceTime)}
          </span>
          <span className="rounded bg-surface-module px-1.5 py-0.5 text-[10px] text-accent-cyan font-telemetry">
            {game.propCount} props
          </span>
        </span>
      </div>
      <MainLinesGrid game={game} />
    </button>
  );
}

export function MarketBrowser({ initialFeed }: MarketBrowserProps) {
  const [props, setProps] = useState<MarketPropRow[]>(initialFeed.props);
  const [sport, setSport] = useState<SportFilter>("all");
  const [dateWindow, setDateWindow] = useState<DateWindowFilter>("all");
  const [market, setMarket] = useState<MarketFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sseConnected, setSseConnected] = useState(false);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);

  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  const { slip, addMarketProp, setCandidatePool } = useParlayDrawer();

  // Preselect from a shared ?game=<event_id> link (unknown ids are ignored).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("game");
    setSelectedGameId(resolveGameParam(initialFeed.games, fromUrl));
  }, [initialFeed.games]);

  // Toggle selection and mirror it to ?game= without a Next navigation (no refetch).
  const selectGame = (eventId: string | null) => {
    const next = eventId === selectedGameId ? null : eventId;
    setSelectedGameId(next);
    try {
      const { pathname, search, hash } = window.location;
      window.history.replaceState(
        window.history.state,
        "",
        withGameParam(pathname, search, hash, next),
      );
    } catch {
      // URL sync is best effort
    }
  };

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

  // Slate is derived from the feed by sport/date only, never by the game filter.
  const slateGames = initialFeed.games.filter(
    (g) =>
      (sport === "all" || g.sportKey === sport) &&
      (dateWindow === "all" || g.dateWindow === dateWindow),
  );
  const selectedGame = slateGames.find((g) => g.eventId === selectedGameId) ?? null;

  const visibleProps = filterMarketProps(props, {
    sport,
    dateWindow,
    market,
    query: searchQuery,
    eventId: selectedGame?.eventId ?? null,
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

      {/* Slate of games with main lines; click a card to filter props */}
      {slateGames.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Upcoming Slate
            </span>
            {selectedGame && (
              <button
                type="button"
                onClick={() => selectGame(null)}
                className="rounded-lg bg-surface-card px-2.5 py-1 text-xs font-medium text-text-muted hover:text-text-primary border border-border-hairline cursor-pointer"
              >
                Clear game filter ✕
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {slateGames.map((g) => (
              <div key={g.eventId} className="flex min-w-0 flex-col gap-1">
                <SlateGameCard
                  game={g}
                  selected={g.eventId === selectedGameId}
                  onSelect={() => selectGame(g.eventId)}
                />
                <Link
                  href={`/games/${g.eventId}`}
                  className="self-end text-xs font-medium text-accent-cyan hover:underline"
                >
                  Open game →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Props Screener Table / List */}
      <div className="rounded-xl bg-surface-card border border-border-hairline overflow-hidden shadow-lg">
        {visibleProps.length === 0 ? (
          <div className="p-12 text-center text-text-muted">
            {selectedGame ? (
              <>
                <p className="font-display text-lg font-semibold text-text-primary">
                  No props for {selectedGame.matchup}
                </p>
                <p className="mt-1 text-xs">
                  Adjust the sport, date, prop market or search filters, or clear the
                  game filter.
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-lg font-semibold text-text-primary">
                  No matching player props found
                </p>
                <p className="mt-1 text-xs">
                  Try adjusting your sport, date window, or prop market filters.
                </p>
              </>
            )}
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

export function MarketPropRowItem({
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
              {prop.hitRateDisplay ?? "Limited history"}
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
