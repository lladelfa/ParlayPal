import { NextResponse } from "next/server";
import { type TrackedBet, type BetLeg, type BetStatus, VALID_BET_STATUSES } from "@/types/bet";
import { calculateBetSummaryMetrics, generateUUID } from "@/lib/ledger";
import { createRedisClient, userBetsKey } from "@/lib/redis";

export const dynamic = "force-dynamic";

function decimalToAmericanOdds(decimal: number): number {
  if (decimal <= 1.0) return 100;
  if (decimal >= 2.0) {
    return Math.round((decimal - 1) * 100);
  }
  return Math.round(-100 / (decimal - 1));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId =
      searchParams.get("userId") ||
      req.headers.get("x-user-id") ||
      "guest-default";
    const statusFilter = searchParams.get("status")?.toLowerCase();

    let bets: TrackedBet[] = [];

    // Attempt to read from Redis
    try {
      const client = createRedisClient();
      const raw = await client.get(userBetsKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          bets = parsed;
        }
      }
      if (typeof client.quit === "function") {
        await client.quit();
      }
    } catch (redisErr) {
      console.warn(
        "PostgreSQL/Redis offline fallback: /api/bets using local memory/cache. Non-blocking warning.",
        redisErr,
      );
    }

    // Filter by status if provided and not "all"
    let filteredBets = bets;
    if (statusFilter && statusFilter !== "all") {
      filteredBets = bets.filter((b) => {
        const bStatus = b.status?.toLowerCase();
        if (statusFilter === "pending") {
          return bStatus === "pending";
        }
        if (statusFilter === "staged") {
          return bStatus === "staged";
        }
        if (statusFilter === "won") {
          return bStatus === "won" || bStatus === "settled_won";
        }
        if (statusFilter === "lost") {
          return bStatus === "lost" || bStatus === "settled_lost";
        }
        return bStatus === statusFilter;
      });
    }

    const metrics = calculateBetSummaryMetrics(bets);

    return NextResponse.json(
      {
        success: true,
        bets: filteredBets,
        metrics,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  } catch (err: any) {
    console.error("Unexpected error in GET /api/bets:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error retrieving user bets.",
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_JSON",
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
            code: "INVALID_BODY",
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
            message: "At least one leg is required.",
          },
        },
        { status: 400 },
      );
    }

    // Validate legs
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

      const oddsVal = leg.offeredDecimalOdds ?? leg.odds ?? leg.decimalOdds;
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
    }

    const rawStake = body.stakeAmount ?? body.stake ?? 50;
    const stakeAmount = Number(rawStake);
    if (isNaN(stakeAmount) || !isFinite(stakeAmount) || stakeAmount <= 0) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_STAKE",
            message: "Stake must be greater than $0.00",
          },
        },
        { status: 400 },
      );
    }

    let decimalOdds = Number(body.decimalOdds ?? body.combinedDecimalOdds);
    if (isNaN(decimalOdds) || !isFinite(decimalOdds) || decimalOdds < 1.01) {
      decimalOdds = body.legs.reduce((acc: number, leg: BetLeg) => {
        const val = parseFloat(
          String(
            leg.offeredDecimalOdds ??
              (leg as any).decimalOdds ??
              (leg as any).odds ??
              1,
          ),
        );
        return isNaN(val) || val < 1.01 ? acc : acc * val;
      }, 1);
      decimalOdds = Number(decimalOdds.toFixed(4));
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

    if (body.status !== undefined && !VALID_BET_STATUSES.includes(body.status)) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_STATUS",
            message: `Invalid bet status: ${body.status}`,
          },
        },
        { status: 400 },
      );
    }

    if (body.quickpickUrl && typeof body.quickpickUrl === "string") {
      const trimmed = body.quickpickUrl.trim();
      if (trimmed && !trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
        return NextResponse.json(
          {
            error: {
              code: "INVALID_URL",
              message: "QuickPick URL must use http or https scheme.",
            },
          },
          { status: 400 },
        );
      }
    }

    const americanOdds =
      body.americanOdds ??
      body.combinedAmericanOdds ??
      decimalToAmericanOdds(decimalOdds);

    const betId =
      typeof body.betId === "string" && body.betId.trim()
        ? body.betId.trim()
        : generateUUID();
    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : generateUUID();

    const status: BetStatus = body.status || "pending";
    const potentialPayout =
      body.potentialPayout !== undefined
        ? Number(body.potentialPayout)
        : Number((stakeAmount * decimalOdds).toFixed(2));

    const trackedBet: TrackedBet = {
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
      status,
      legs: body.legs,
      quickpickUrl: body.quickpickUrl || "",
      placedAt: body.placedAt || new Date().toISOString(),
      stagedAt: body.stagedAt || new Date().toISOString(),
      settledAt: body.settledAt || null,
      liveProgress: body.liveProgress,
    };

    // Persist to Redis
    try {
      const client = createRedisClient();
      const raw = await client.get(userBetsKey(userId));
      let existing: TrackedBet[] = [];
      if (raw) {
        try {
          existing = JSON.parse(raw);
        } catch {}
      }
      const updated = [trackedBet, ...existing.filter((b) => b.betId !== betId)];
      await client.set(userBetsKey(userId), JSON.stringify(updated));
      if (typeof client.quit === "function") {
        await client.quit();
      }
    } catch (redisErr) {
      console.warn("PostgreSQL/Redis offline fallback during bet save:", redisErr);
    }

    return NextResponse.json(
      {
        success: true,
        bet: trackedBet,
      },
      { status: 201 },
    );
  } catch (err: any) {
    console.error("Unexpected error in POST /api/bets:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error creating bet.",
        },
      },
      { status: 500 },
    );
  }
}
