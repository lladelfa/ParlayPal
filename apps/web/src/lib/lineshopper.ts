import type { ParlayLeg } from "@/types/parlay";
import {
  INTEGRATED_SPORTSBOOKS,
  SPORTSBOOK_REGISTRY,
  type BookmakerParlayPricing,
  type LineshopperComparisonResult,
  type SportsbookId,
  type SportsbookQuote,
} from "@/types/lineshopper";
import { decimalToAmerican } from "./math";

export const DEFAULT_REFERENCE_STAKE = 50;

/**
 * Derives deterministic fallback quotes across sportsbooks when a leg
 * does not have explicit per-book quotes populated.
 */
export function getDeterministicLegQuote(
  leg: ParlayLeg,
  bookId: SportsbookId,
): SportsbookQuote {
  const baseDecimal = parseFloat(leg.offeredDecimalOdds) || 2.0;

  // Realistic market variance multipliers relative to consensus
  const multipliers: Record<SportsbookId, number> = {
    fanduel: 1.025,
    draftkings: 1.0,
    betmgm: 0.985,
    caesars: 0.965,
  };

  const multiplier = multipliers[bookId] ?? 1.0;
  const derivedDecimal = Math.max(1.01, parseFloat((baseDecimal * multiplier).toFixed(4)));
  const americanOdds = decimalToAmerican(derivedDecimal);

  return {
    sportsbook: bookId,
    sportsbookId: bookId,
    decimalOdds: derivedDecimal,
    americanOdds,
    isAvailable: true,
  };
}

/**
 * Calculates combined decimal and American payout for a single bookmaker across legs.
 */
export function calculateBookmakerPayout(
  quotes: (SportsbookQuote | number | string | null | undefined)[],
): {
  combinedDecimalOdds: number;
  combinedAmericanOdds: number;
  formattedAmericanOdds: string;
  isAvailable: boolean;
  missingLegCount: number;
} {
  if (quotes.length === 0) {
    return {
      combinedDecimalOdds: 1.01,
      combinedAmericanOdds: 100,
      formattedAmericanOdds: "+100",
      isAvailable: true,
      missingLegCount: 0,
    };
  }

  let combinedDecimal = 1.0;
  let missingLegCount = 0;
  let isAvailable = true;

  for (const quote of quotes) {
    if (quote === null || quote === undefined) {
      missingLegCount++;
      isAvailable = false;
      continue;
    }

    let dec: number;
    let available = true;

    if (typeof quote === "number") {
      dec = quote;
      available = Number.isFinite(dec) && dec >= 1.01;
    } else if (typeof quote === "string") {
      dec = parseFloat(quote);
      available = Number.isFinite(dec) && dec >= 1.01;
    } else {
      // SportsbookQuote object
      available = quote.isAvailable !== false;
      dec =
        typeof quote.decimalOdds === "number"
          ? quote.decimalOdds
          : typeof quote.decimalOdds === "string"
            ? parseFloat(quote.decimalOdds)
            : NaN;
      if (!Number.isFinite(dec) || dec < 1.01) {
        available = false;
      }
    }

    if (!available) {
      missingLegCount++;
      isAvailable = false;
    } else {
      combinedDecimal *= dec;
    }
  }

  const finalDecimal = Math.max(1.01, combinedDecimal);
  const finalAmerican = decimalToAmerican(finalDecimal);
  const formattedAmerican = finalAmerican > 0 ? `+${finalAmerican}` : `${finalAmerican}`;

  return {
    combinedDecimalOdds: parseFloat(finalDecimal.toFixed(4)),
    combinedAmericanOdds: finalAmerican,
    formattedAmericanOdds: formattedAmerican,
    isAvailable,
    missingLegCount,
  };
}

/**
 * Calculates dollar edge given best and runner up decimal odds and reference stake.
 */
export function calculateDollarEdge(
  bestDecimalOdds: number,
  runnerUpDecimalOdds: number,
  referenceStake: number = DEFAULT_REFERENCE_STAKE,
): number {
  if (bestDecimalOdds < runnerUpDecimalOdds) return 0;
  const rawEdge = (bestDecimalOdds - runnerUpDecimalOdds) * referenceStake;
  return Math.round(rawEdge * 100) / 100;
}

export interface CompareMultiBookOddsOptions {
  referenceStake?: number;
  benchmarkBookId?: SportsbookId;
  selectedSportsbook?: SportsbookId | null;
}

/**
 * Core lineshopper pricing comparator.
 *
 * Compares multi-leg parlay payouts across FanDuel, DraftKings, BetMGM, and Caesars.
 * Designates Best Value Book (when legs.length >= 2), handles missing lines gracefully,
 * and computes dollar edge.
 */
export function compareMultiBookOdds(
  legs: ParlayLeg[],
  options?: CompareMultiBookOddsOptions,
): LineshopperComparisonResult {
  const referenceStake = options?.referenceStake ?? DEFAULT_REFERENCE_STAKE;
  const selectedBookId = options?.selectedSportsbook ?? null;

  if (legs.length === 0) {
    const emptyBookmakers: Record<SportsbookId, BookmakerParlayPricing> = {} as any;
    const emptyList: BookmakerParlayPricing[] = [];

    for (const bookId of INTEGRATED_SPORTSBOOKS) {
      const meta = SPORTSBOOK_REGISTRY[bookId];
      const pricing: BookmakerParlayPricing = {
        sportsbookId: bookId,
        name: meta.name,
        shortName: meta.shortName,
        brandColor: meta.brandColor,
        accentColor: meta.accentColor,
        isAvailable: false,
        missingLegCount: 0,
        combinedDecimalOdds: 1.01,
        combinedAmericanOdds: 100,
        formattedAmericanOdds: "+100",
        isBestValue: false,
        isSelected: selectedBookId === bookId,
        payoutOnReferenceStake: 0,
        profitOnReferenceStake: 0,
      };
      emptyBookmakers[bookId] = pricing;
      emptyList.push(pricing);
    }

    return {
      bookmakers: emptyBookmakers,
      bookmakerList: emptyList,
      bestValueBookId: null,
      runnerUpBookId: null,
      bestDecimalOdds: null,
      bestAmericanOdds: null,
      runnerUpDecimalOdds: null,
      runnerUpAmericanOdds: null,
      dollarEdge: 0,
      edgeDescription: "",
      hasComparison: false,
      referenceStake,
      totalLegs: 0,
      hasMissingLines: false,
    };
  }

  // Gather quotes for each bookmaker across all legs
  const bookmakerQuotes: Record<SportsbookId, SportsbookQuote[]> = {
    fanduel: [],
    draftkings: [],
    betmgm: [],
    caesars: [],
  };

  for (const leg of legs) {
    for (const bookId of INTEGRATED_SPORTSBOOKS) {
      if (leg.sportsbookQuotes) {
        if (leg.sportsbookQuotes[bookId] !== undefined) {
          bookmakerQuotes[bookId].push(leg.sportsbookQuotes[bookId]!);
        } else {
          // Explicit quotes provided on leg, but this bookmaker is omitted -> unavailable
          bookmakerQuotes[bookId].push({
            sportsbook: bookId,
            sportsbookId: bookId,
            isAvailable: false,
          });
        }
      } else {
        // Fallback to deterministic quote when leg has no sportsbookQuotes object
        bookmakerQuotes[bookId].push(getDeterministicLegQuote(leg, bookId));
      }
    }
  }

  const bookmakers: Record<SportsbookId, BookmakerParlayPricing> = {} as any;
  const bookmakerList: BookmakerParlayPricing[] = [];
  let hasMissingLines = false;

  for (const bookId of INTEGRATED_SPORTSBOOKS) {
    const meta = SPORTSBOOK_REGISTRY[bookId];
    const quotes = bookmakerQuotes[bookId];
    const payout = calculateBookmakerPayout(quotes);

    if (!payout.isAvailable) {
      hasMissingLines = true;
    }

    const payoutAmount = Math.round(payout.combinedDecimalOdds * referenceStake * 100) / 100;
    const profitAmount =
      Math.round((payout.combinedDecimalOdds - 1.0) * referenceStake * 100) / 100;

    const pricing: BookmakerParlayPricing = {
      sportsbookId: bookId,
      name: meta.name,
      shortName: meta.shortName,
      brandColor: meta.brandColor,
      accentColor: meta.accentColor,
      isAvailable: payout.isAvailable,
      missingLegCount: payout.missingLegCount,
      combinedDecimalOdds: payout.combinedDecimalOdds,
      combinedAmericanOdds: payout.combinedAmericanOdds,
      formattedAmericanOdds: payout.formattedAmericanOdds,
      isBestValue: false, // assigned only when legs.length >= 2
      isSelected: selectedBookId === bookId,
      payoutOnReferenceStake: payoutAmount,
      profitOnReferenceStake: profitAmount,
    };

    bookmakers[bookId] = pricing;
    bookmakerList.push(pricing);
  }

  const availableBooks = bookmakerList.filter((b) => b.isAvailable);

  // Per spec boundary: Only designate Best Value Book when at least 2 legs are present and priced
  let bestBook: BookmakerParlayPricing | null = null;
  let runnerUpBook: BookmakerParlayPricing | null = null;
  let dollarEdge = 0;
  let edgeDescription = "";

  if (legs.length >= 2) {
    // Tie-breaker priority follows INTEGRATED_SPORTSBOOKS order: fanduel > draftkings > betmgm > caesars
    for (const book of availableBooks) {
      if (!bestBook || book.combinedDecimalOdds > bestBook.combinedDecimalOdds) {
        bestBook = book;
      }
    }

    if (bestBook) {
      bestBook.isBestValue = true;
      bookmakers[bestBook.sportsbookId].isBestValue = true;

      // Find Runner-Up Book among remaining available books
      for (const book of availableBooks) {
        if (book.sportsbookId === bestBook.sportsbookId) continue;
        if (!runnerUpBook || book.combinedDecimalOdds > runnerUpBook.combinedDecimalOdds) {
          runnerUpBook = book;
        }
      }

      if (runnerUpBook) {
        dollarEdge = calculateDollarEdge(
          bestBook.combinedDecimalOdds,
          runnerUpBook.combinedDecimalOdds,
          referenceStake,
        );

        const diff = bestBook.combinedDecimalOdds - runnerUpBook.combinedDecimalOdds;
        if (diff === 0 || dollarEdge === 0) {
          edgeDescription = `+$0 Edge (Even with ${runnerUpBook.shortName})`;
        } else {
          const roundedDollar = Math.round(dollarEdge);
          edgeDescription = `+$${roundedDollar} on $${referenceStake} bet (vs ${runnerUpBook.shortName} ${runnerUpBook.formattedAmericanOdds})`;
        }
      } else if (availableBooks.length === 1) {
        edgeDescription = `Only available book offering all ${legs.length} legs`;
      }
    }
  }

  return {
    bookmakers,
    bookmakerList,
    bestValueBookId: bestBook ? bestBook.sportsbookId : null,
    runnerUpBookId: runnerUpBook ? runnerUpBook.sportsbookId : null,
    bestDecimalOdds: bestBook ? bestBook.combinedDecimalOdds : null,
    bestAmericanOdds: bestBook ? bestBook.combinedAmericanOdds : null,
    runnerUpDecimalOdds: runnerUpBook ? runnerUpBook.combinedDecimalOdds : null,
    runnerUpAmericanOdds: runnerUpBook ? runnerUpBook.combinedAmericanOdds : null,
    dollarEdge,
    edgeDescription,
    hasComparison: availableBooks.length > 0,
    referenceStake,
    totalLegs: legs.length,
    hasMissingLines,
  };
}
