"use client";

import React, { useState } from "react";
import Link from "next/link";
import type { MarketPropRow, ScheduledEventSummary } from "@/types/market";
import { ParlayDrawerProvider, useParlayDrawer } from "@/context/ParlayDrawerContext";
import { compareToLine } from "@/lib/game-logs";
import { filterByTab, marketTabs } from "@/lib/market-filters";
import { MainLinesGrid, MarketPropRowItem } from "./MarketBrowser";
import { ParlayDrawer } from "./ParlayDrawer";
import { LegSwapperModal } from "./LegSwapperModal";

interface GameDetailProps {
  game: ScheduledEventSummary;
  props: MarketPropRow[];
  /** propId -> newest-first stats; null when no usable log is cached. */
  logs: Record<string, number[] | null>;
}

function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const MARK_LABEL = { over: "Over", under: "Under", push: "Push" } as const;
const MARK_STYLE = {
  over: "text-accent-emerald border-accent-emerald/30",
  under: "text-accent-rose border-accent-rose/30",
  push: "text-text-muted border-border-hairline",
} as const;

/** Newest-first game values, each marked over/under the prop line. */
export function PlayerHistory({
  stats,
  line,
}: {
  stats: number[] | null;
  line: number | null | undefined;
}) {
  if (!stats) {
    return <p className="text-xs text-text-muted">Limited history</p>;
  }
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Recent games, most recent first">
      {stats.map((value, idx) => {
        const mark = compareToLine(value, line);
        return (
          <li
            key={idx}
            className={`flex min-w-[3.25rem] flex-col items-center rounded-lg border bg-surface-module px-2 py-1 font-telemetry ${
              mark ? MARK_STYLE[mark] : "text-text-primary border-border-hairline"
            }`}
          >
            <span className="text-sm font-bold">{value}</span>
            {mark && <span className="text-[9px] uppercase">{MARK_LABEL[mark]}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PropWithHistory({
  prop,
  stats,
}: {
  prop: MarketPropRow;
  stats: number[] | null;
}) {
  const [open, setOpen] = useState(false);
  const { slip, addMarketProp } = useParlayDrawer();
  const inSlip = slip.legs.some((l) => l.propId === prop.propId);

  return (
    <div>
      <MarketPropRowItem
        prop={prop}
        isInSlip={inSlip}
        onAddToSlip={() => addMarketProp(prop)}
      />
      <div className="px-4 pb-3">
        {stats ? (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="text-xs font-medium text-accent-cyan cursor-pointer hover:underline"
            >
              {open ? "Hide recent games ▴" : "Recent games ▾"}
            </button>
            {open && (
              <div className="mt-2">
                <PlayerHistory stats={stats} line={prop.lineValue} />
              </div>
            )}
          </>
        ) : (
          <PlayerHistory stats={null} line={prop.lineValue} />
        )}
      </div>
    </div>
  );
}

export function GameDetailView({ game, props, logs }: GameDetailProps) {
  const tabs = marketTabs(props);
  const [tab, setTab] = useState<string>("all");
  const visible = filterByTab(props, tab);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-xs font-medium text-accent-cyan hover:underline">
          ← Back to slate
        </Link>
        <h1 className="font-display text-2xl font-bold text-text-primary">{game.matchup}</h1>
        <p className="font-telemetry text-xs text-text-muted" suppressHydrationWarning>
          {game.sportKey.toUpperCase()} · {formatStart(game.commenceTime)}
        </p>
      </header>

      <section className="rounded-xl border border-border-hairline bg-surface-card p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Main Lines
        </h2>
        <MainLinesGrid game={game} />
      </section>

      <section className="overflow-hidden rounded-xl border border-border-hairline bg-surface-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-hairline/60 p-4">
          <h2 className="mr-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            Player Props
          </h2>
          {[{ key: "all", label: "All" }, ...tabs].map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium cursor-pointer ${
                tab === t.key
                  ? "bg-accent-violet text-text-primary"
                  : "bg-surface-module text-text-muted border border-border-hairline hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-text-muted">
            No props for {game.matchup} yet.
          </p>
        ) : (
          <div className="divide-y divide-border-hairline/60">
            {visible.map((p) => (
              <PropWithHistory key={p.propId} prop={p} stats={logs[p.propId] ?? null} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function GameDetail(props: GameDetailProps) {
  return (
    <ParlayDrawerProvider initialCandidates={props.props}>
      <div className="flex flex-col items-start gap-8 xl:flex-row">
        <div className="w-full min-w-0 flex-1">
          <GameDetailView {...props} />
        </div>
        <ParlayDrawer />
      </div>
      <LegSwapperModal />
    </ParlayDrawerProvider>
  );
}
