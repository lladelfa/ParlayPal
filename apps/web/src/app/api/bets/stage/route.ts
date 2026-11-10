import { NextResponse } from "next/server";
import type { BetLeg, StagedBet, StageBetResponse } from "@/types/bet";

export const dynamic = "force-dynamic";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function decimalToAmericanOdds(decimal: number): number {
  if (decimal <= 1.0) return 100;
  if (decimal >= 2.0) {
    return Math.round((decimal - 1) * 100);
  }
  return Math.round(-100 / (decimal - 1));
}

/**
 * POST /api/bets/stage
 *
 * Auto-stages tickets with status 'staged' into the pending bet ledger.
 * Accessible to guest/unauthenticated users with automatic UUID v4 generation.
 * Rejects empty legs, invalid odds (D < 1.01), and suspect stale lines (EV > 10.0%).
 */
export async function POST(req: Request) {
  try {
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 102400) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_LEG_DATA",
            message: "Request payload exceeds maximum allowed size (100KB).",
          },
        },
        { status: 413 },
      );
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_LEG_DATA",
            message: "Request body must be valid JSON.",
          },
        },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_LEG_DATA",
            message: "Request body must be an object.",
          },
        },
        { status: 400 },
      );
    }

    if (!body.sportsbook || typeof body.sportsbook !== "string" || !body.sportsbook.trim()) {
      return NextResponse.json(
        {
          error: {
            code: "MISSING_REQUIRED_FIELDS",
            message: "Field 'sportsbook' is required.",
          },
        },
        { status: 400 },
      );
    }

    if (!Array.isArray(body.legs) || body.legs.length === 0) {
      return NextResponse.json(
        {
          error: {
            code: "EMPTY_PARLAY_LEGS",
            message: "At least one leg is required to stage a bet.",
          },
        },
        { status: 400 },
      );
    }

    if (body.legs.length > 8) {
      return NextResponse.json(
        {
          error: {
            code: "MAX_LEGS_EXCEEDED",
            message: "Maximum 8 legs allowed per staged bet.",
          },
        },
        { status: 400 },
      );
    }

    // Validate each leg
    for (let i = 0; i < body.legs.length; i++) {
      const leg = body.legs[i];
      if (!leg || typeof leg !== "object") {
        return NextResponse.json(
          {
            error: {
              code: "INVALID_LEG_DATA",
              message: `Leg at index ${i} is invalid.`,
            },
          },
          { status: 400 },
        );
      }

      if (!leg.propId || !leg.playerName || !leg.selection) {
        return NextResponse.json(
          {
            error: {
              code: "INVALID_LEG_DATA",
              message: `Leg at index ${i} is missing required fields (propId, playerName, or selection).`,
            },
          },
          { status: 400 },
        );
      }

      const oddsVal = leg.offeredDecimalOdds ?? leg.odds ?? leg.decimalOdds;
      if (oddsVal === undefined || oddsVal === null) {
        return NextResponse.json(
          {
            error: {
              code: "INVALID_ODDS",
              message: `Leg at index ${i} is missing offeredDecimalOdds.`,
            },
          },
          { status: 400 },
        );
      }

      const parsedOdds = parseFloat(String(oddsVal));
      if (
        isNaN(parsedOdds) ||
        !isFinite(parsedOdds) ||
        parsedOdds < 1.01 ||
        parsedOdds > 9999.9999
      ) {
        return NextResponse.json(
          {
            error: {
              code: "INVALID_ODDS",
              message: `Leg at index ${i} has invalid decimal odds (${oddsVal}). Must satisfy 1.01 <= D <= 9999.9999.`,
            },
          },
          { status: 400 },
        );
      }

      const evVal = leg.guardedEv ?? leg.ev;
      if (evVal !== undefined && evVal !== null) {
        const parsedEv = parseFloat(String(evVal));
        if (!isNaN(parsedEv) && parsedEv > 0.10) {
          return NextResponse.json(
            {
              error: {
                code: "SUSPECT_STALE_LINE",
                message: `Leg at index ${i} has EV > 10.0% (${(parsedEv * 100).toFixed(1)}%), flagged as suspect stale line.`,
              },
            },
            { status: 400 },
          );
        }
      }

      if (leg.status === "SUSPECT_STALE_LINE" || leg.isSuspectStaleLine) {
        return NextResponse.json(
          {
            error: {
              code: "SUSPECT_STALE_LINE",
              message: `Leg at index ${i} is flagged as SUSPECT_STALE_LINE.`,
            },
          },
          { status: 400 },
        );
      }
    }

    // Build normalized staged bet
    const betId =
      typeof body.betId === "string" && body.betId.trim()
        ? body.betId.trim()
        : generateUUID();
    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : generateUUID();

    const hasExplicitStake = body.stakeAmount !== undefined || body.stake !== undefined;
    const rawStake = hasExplicitStake ? (body.stakeAmount ?? body.stake) : 50;
    const stakeAmount = Number(rawStake);
    if (rawStake === null || isNaN(stakeAmount) || !isFinite(stakeAmount) || stakeAmount <= 0) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_LEG_DATA",
            message: "Stake amount must be a positive finite number.",
          },
        },
        { status: 400 },
      );
    }

    let decimalOdds = Number(body.decimalOdds ?? body.combinedDecimalOdds);
    if (isNaN(decimalOdds) || !isFinite(decimalOdds) || decimalOdds < 1.01) {
      // Calculate product of legs if missing
      const mult = body.legs.reduce((acc: number, leg: BetLeg) => {
        const val = parseFloat(
          String(
            leg.offeredDecimalOdds ??
              (leg as any).odds ??
              (leg as any).decimalOdds ??
              1,
          ),
        );
        return isNaN(val) || val < 1.01 ? acc : acc * val;
      }, 1);
      decimalOdds = Number(mult.toFixed(4));
    }

    if (
      isNaN(decimalOdds) ||
      !isFinite(decimalOdds) ||
      decimalOdds < 1.01 ||
      decimalOdds > 9999.9999
    ) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_ODDS",
            message: `Ticket decimal odds (${decimalOdds}) must satisfy 1.01 <= D <= 9999.9999.`,
          },
        },
        { status: 400 },
      );
    }

    let americanOdds = Number(body.americanOdds ?? body.combinedAmericanOdds);
    if (isNaN(americanOdds)) {
      americanOdds = decimalToAmericanOdds(decimalOdds);
    }

    const potentialPayout =
      body.potentialPayout !== undefined
        ? Number(body.potentialPayout)
        : Number((stakeAmount * decimalOdds).toFixed(2));

    const quickpickUrl = typeof body.quickpickUrl === "string" ? body.quickpickUrl : "";
    const stagedAt =
      typeof body.stagedAt === "string" && body.stagedAt
        ? body.stagedAt
        : new Date().toISOString();

    const stagedBet: StagedBet = {
      betId,
      userId,
      sportsbook: body.sportsbook,
      decimalOdds,
      americanOdds,
      combinedDecimalOdds: decimalOdds,
      combinedAmericanOdds: americanOdds,
      stakeAmount,
      stake: stakeAmount,
      potentialPayout,
      status: "staged",
      legs: body.legs,
      quickpickUrl,
      stagedAt,
    };

    const responsePayload: StageBetResponse = {
      success: true,
      bet: stagedBet,
      ...stagedBet,
    };

    return NextResponse.json(responsePayload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: any) {
    console.error("Unexpected error in /api/bets/stage:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error during bet staging.",
        },
      },
      { status: 500 },
    );
  }
}
