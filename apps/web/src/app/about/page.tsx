import React from "react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About & How It Works | ParlayPal",
  description:
    "What ParlayPal is, how its Hybrid Value Score, hit rates and EV are calculated, and what they do and do not mean.",
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 rounded-xl border border-border-hairline bg-surface-card p-5"
    >
      <h2 className="font-display text-xl font-semibold text-text-primary">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-text-muted">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link href="/" className="text-xs font-semibold text-accent-cyan hover:underline">
        ← Back to ParlayPal
      </Link>
      <header className="mt-4 mb-6 border-b border-border-hairline pb-6">
        <h1 className="font-display text-[28px] leading-[36px] font-bold tracking-tight text-text-primary">
          About &amp; How It Works
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          What each number on the site means, so you know how far to trust it before you act.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <Section id="what" title="What ParlayPal is">
          <p>
            ParlayPal is a betting research tool for NFL and NBA player props and game lines. It
            compares sportsbook prices, removes the bookmaker margin to estimate a fair price, and
            shows where the offered price looks better than that estimate. It does not place bets
            for you.
          </p>
        </Section>

        <Section id="presets" title="The preset feed">
          <p>
            Curated Presets are ready-made 2 to 4 leg parlays built from upcoming props. Each card
            shows the combined price, the combined EV, a Score, and a short rationale for every
            leg. Legs are skipped when the line looks stale, the game has started, or the
            estimated chance is too low to be meaningful.
          </p>
        </Section>

        <Section id="browser" title="The market browser and game pages">
          <p>
            The browser lists the day&apos;s games with their spread, moneyline and total. Click a
            game to filter its props, or open its game page for main lines, props by market and
            each player&apos;s history. You can sort props by player, team, market, line, odds,
            EV, hit rate or Score. A missing value shows as &quot;—&quot; and always sorts last.
          </p>
        </Section>

        <Section id="drawer" title="The parlay drawer and lineshopping">
          <p>
            Add any prop to the drawer to build your own parlay, swap legs, and see the combined
            price. When legs come from the same game, the price is adjusted for how strongly the
            outcomes tend to move together. The lineshopper compares the same selection across
            sportsbooks so you can take the best available price.
          </p>
        </Section>

        <Section id="quickpick" title="QuickPick handoff">
          <p>
            QuickPick turns your slip into a link that opens your chosen sportsbook with the
            selections staged. You still review and confirm the bet there.
          </p>
        </Section>

        <Section id="tracking" title="Bet tracking and CLV">
          <p>
            My Bets records the bets you log. Closing Line Value (CLV) compares the price you took
            with the price at the close of betting. Beating the closing price over many bets is a
            common sign of a genuine edge; a single bet&apos;s result mostly reflects luck.
          </p>
        </Section>

        <Section id="score" title="The Hybrid Value Score">
          <p>
            The Score is a 0 to 100 index that blends two things: how consistently the player has
            cleared the line recently, and how good the price is.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-text-primary">Consistency (60%)</strong>: the L10 hit rate,
              as a percentage. For a preset card this is the average across legs that have
              history.
            </li>
            <li>
              <strong className="text-text-primary">Price (40%)</strong>: the guarded EV, rescaled
              with EV x 10 + 50 (EV in percent) and limited to 0 to 100. 0% EV maps to 50, +5% EV
              or more to 100, and -5% EV or less to 0.
            </li>
          </ul>
          <p>
            <strong className="text-text-primary">Missing data:</strong> if no leg has any
            history, the Score uses the EV component alone instead of inventing a hit rate. A
            missing hit rate is never filled with a default.
          </p>
          <p>
            <strong className="text-text-primary">Direction:</strong> higher is better, and the
            default sort ranks by Score, highest first.
          </p>
          <p>
            <strong className="text-text-primary">What a high Score means:</strong> the player
            has recently cleared this line often and the offered price is better than the
            estimated fair price. It does not mean the bet will win, and it does not predict
            injuries, minutes, matchups or game script. Even a very high Score is a lean, not a
            guarantee.
          </p>
        </Section>

        <Section id="hit-rates" title="Consistency hit rates">
          <p>
            A hit rate is the share of a player&apos;s recent games that cleared the line, shown
            for L5 (last 5 games), L10 (last 10) and Season. Games that land exactly on the line
            are pushes and are skipped.
          </p>
          <p>
            For an Over, a game is a hit when the stat is above the line. For an Under, it is a
            hit when the stat is below the line, so an Under card reads in the under direction.
          </p>
          <p>
            <strong className="text-text-primary">Limited history</strong> means there are no
            usable game logs for that player and line yet. The site shows this label instead of a
            made-up number, and the Score then relies on price alone.
          </p>
        </Section>

        <Section id="ev" title="EV and the 10% suspect-line guard">
          <p>
            EV (expected value) is the fair chance of winning times the offered decimal odds,
            minus 1. A +3% EV means that, if the fair estimate is right, each $100 staked is
            worth about $3 more than it costs over the long run. The fair chance comes from
            removing the bookmaker margin from sharp prices.
          </p>
          <p>
            Any prop whose EV is above 10% is treated as a likely stale or mispriced line, marked
            SUSPECT_STALE_LINE, and kept out of the public EV feed and the curated presets. An
            edge that large is more often a data problem than an opportunity.
          </p>
        </Section>

        <Section id="disclaimer" title="Not betting advice">
          <p>
            ParlayPal is for information and research only. It is not betting advice, no outcome
            is guaranteed, and you can lose money. Check every line and price with your
            sportsbook before you bet, only stake what you can afford to lose, and if gambling is
            a problem for you, seek help from a local support service.
          </p>
        </Section>
      </div>
    </main>
  );
}
