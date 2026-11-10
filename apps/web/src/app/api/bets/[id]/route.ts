import { NextResponse } from "next/server";
import { type TrackedBet, type BetStatus, VALID_BET_STATUSES } from "@/types/bet";
import { createRedisClient, userBetsKey } from "@/lib/redis";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: betId } = await params;
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

    if (body.stakeAmount !== undefined || body.stake !== undefined) {
      const stakeVal = Number(body.stakeAmount ?? body.stake);
      if (isNaN(stakeVal) || !isFinite(stakeVal) || stakeVal <= 0) {
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
    }

    const userId =
      body.userId ||
      req.headers.get("x-user-id") ||
      "guest-default";

    let existingBet: TrackedBet | null = null;
    let allBets: TrackedBet[] = [];

    // Check Redis
    try {
      const client = createRedisClient();
      const raw = await client.get(userBetsKey(userId));
      if (raw) {
        allBets = JSON.parse(raw);
        existingBet = allBets.find((b) => b.betId === betId) || null;
      }

      if (existingBet) {
        const finalizedStatuses = new Set([
          "won",
          "lost",
          "settled_won",
          "settled_lost",
          "void",
          "push",
        ]);

        if (finalizedStatuses.has(existingBet.status)) {
          return NextResponse.json(
            {
              error: {
                code: "ALREADY_SETTLED",
                message: `Cannot re-settle an already finalized bet with status: ${existingBet.status}`,
              },
            },
            { status: 400 },
          );
        }

        const newStatus: BetStatus = body.status || existingBet.status;
        const newStake =
          body.stakeAmount !== undefined
            ? Number(body.stakeAmount)
            : body.stake !== undefined
              ? Number(body.stake)
              : existingBet.stakeAmount;
        const newPotentialPayout =
          body.potentialPayout !== undefined
            ? Number(body.potentialPayout)
            : Number((newStake * existingBet.decimalOdds).toFixed(2));

        const updatedBet: TrackedBet = {
          ...existingBet,
          status: newStatus,
          stakeAmount: newStake,
          stake: newStake,
          potentialPayout: newPotentialPayout,
          placedAt:
            existingBet.status === "staged" && newStatus === "pending"
              ? new Date().toISOString()
              : existingBet.placedAt,
          settledAt: finalizedStatuses.has(newStatus)
            ? new Date().toISOString()
            : existingBet.settledAt,
        };

        const updatedList = allBets.map((b) =>
          b.betId === betId ? updatedBet : b,
        );
        await client.set(userBetsKey(userId), JSON.stringify(updatedList));

        if (typeof client.quit === "function") {
          await client.quit();
        }

        return NextResponse.json(
          {
            success: true,
            bet: updatedBet,
          },
          { status: 200 },
        );
      }

      if (typeof client.quit === "function") {
        await client.quit();
      }
    } catch (redisErr) {
      console.warn("PostgreSQL/Redis offline fallback during bet patch:", redisErr);
    }

    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Bet with id ${betId} not found.`,
        },
      },
      { status: 404 },
    );
  } catch (err: any) {
    console.error("Unexpected error in PATCH /api/bets/[id]:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error updating bet.",
        },
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { id: betId } = await params;
    const { searchParams } = new URL(req.url);
    const userId =
      searchParams.get("userId") ||
      req.headers.get("x-user-id") ||
      "guest-default";

    try {
      const client = createRedisClient();
      const raw = await client.get(userBetsKey(userId));
      if (raw) {
        const allBets: TrackedBet[] = JSON.parse(raw);
        const filtered = allBets.filter((b) => b.betId !== betId);
        await client.set(userBetsKey(userId), JSON.stringify(filtered));
      }
      if (typeof client.quit === "function") {
        await client.quit();
      }
    } catch (redisErr) {
      console.warn("PostgreSQL/Redis offline fallback during bet delete:", redisErr);
    }

    return NextResponse.json(
      {
        success: true,
        betId,
      },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("Unexpected error in DELETE /api/bets/[id]:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error deleting bet.",
        },
      },
      { status: 500 },
    );
  }
}
