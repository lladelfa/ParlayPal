import { NextResponse } from "next/server";
import { calculateParlaySlip } from "@/lib/parlay";
import { createRedisClient, sgpAuditKey } from "@/lib/redis";
import type { ParlayLeg, SgpCorrelationAuditItem, SgpPriceResponse } from "@/types/parlay";

export const dynamic = "force-dynamic";

/**
 * Normalizes Redis cached envelope or audit payload to the camelCase SgpPriceResponse contract.
 */
function normalizeSgpPriceResponse(
  cachedAudit: any,
  fallbackEventId: string,
  fallbackSportKey: string = "all",
): SgpPriceResponse {
  const normalizedAuditItems: SgpCorrelationAuditItem[] = (
    cachedAudit.correlationAudit ||
    cachedAudit.correlation_audit ||
    []
  ).map((item: any) => {
    const corr =
      typeof item.correlationCoefficient === "number"
        ? item.correlationCoefficient
        : parseFloat(item.correlation_coefficient) || 0;

    let synergy: "positive" | "negative" | "neutral" = "neutral";
    if (item.synergyType) {
      synergy = item.synergyType;
    } else if (item.impact) {
      synergy = String(item.impact).includes("pos")
        ? "positive"
        : String(item.impact).includes("neg")
          ? "negative"
          : "neutral";
    } else if (corr > 0.10) {
      synergy = "positive";
    } else if (corr < 0) {
      synergy = "negative";
    }

    return {
      legAPropId: item.legAPropId || item.leg_a_prop_id || "",
      legBPropId: item.legBPropId || item.leg_b_prop_id || "",
      legADescription: item.legADescription || item.leg_a_description || item.leg_1 || "Leg A",
      legBDescription: item.legBDescription || item.leg_b_description || item.leg_2 || "Leg B",
      correlationCoefficient: corr,
      synergyType: synergy,
      rationale:
        item.rationale ||
        item.reason ||
        `Correlation coefficient ${corr.toFixed(2)} between selections.`,
    };
  });

  return {
    eventId: cachedAudit.eventId || cachedAudit.event_id || fallbackEventId,
    sportKey: cachedAudit.sportKey || cachedAudit.sport_key || fallbackSportKey,
    unadjustedFairProbability:
      cachedAudit.unadjustedFairProbability ||
      cachedAudit.unadjusted_fair_probability ||
      "0.25000",
    sgpFairProbability:
      cachedAudit.sgpFairProbability || cachedAudit.sgp_fair_probability || "0.25000",
    sgpDecimalOdds: cachedAudit.sgpDecimalOdds || cachedAudit.sgp_decimal_odds || "1.9091",
    sgpAmericanOdds: cachedAudit.sgpAmericanOdds ?? cachedAudit.sgp_american_odds ?? 100,
    hasPositiveSynergy:
      cachedAudit.hasPositiveSynergy ?? cachedAudit.has_positive_synergy ?? false,
    correlationAudit: normalizedAuditItems,
    isSameGameParlay: true,
    source: cachedAudit.source || "cache",
    timestamp: cachedAudit.timestamp || cachedAudit.updated_at,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const eventId: string | undefined = body.eventId || body.event_id;
    const sportKey: string = body.sportKey || body.sport_key || "all";
    const legs: ParlayLeg[] | undefined = body.legs;

    if (!eventId || !Array.isArray(legs) || legs.length < 2) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_SGP_LEGS",
            message: "Same-Game Parlay evaluation requires at least 2 legs sharing an eventId.",
          },
        },
        { status: 400 },
      );
    }

    // Validate that all legs share the exact same eventId
    const hasMismatchedEvent = legs.some((leg) => leg.eventId && leg.eventId !== eventId);
    if (hasMismatchedEvent) {
      return NextResponse.json(
        {
          error: {
            code: "EVENT_ID_MISMATCH",
            message: "All legs in an SGP evaluation must share the exact same eventId.",
          },
        },
        { status: 400 },
      );
    }

    // Attempt Redis cache lookup at sgp:audit:{eventId}
    const redisClient = createRedisClient();
    let cachedAudit: any = null;

    try {
      if (redisClient.connect) {
        await redisClient.connect();
      }
      const raw = await redisClient.get(sgpAuditKey(eventId));
      if (raw) {
        const envelope = JSON.parse(raw);
        cachedAudit = envelope.audit || envelope;
      }
    } catch (redisError) {
      console.warn(
        `Redis unavailable for SGP audit (${eventId}); utilizing empirical heuristic fallback.`,
        redisError,
      );
    } finally {
      try {
        redisClient.disconnect();
      } catch {}
    }

    if (cachedAudit) {
      // Verify that cached audit matches requested leg selections
      const requestedPropIds = new Set(legs.map((l) => l.propId));
      let cacheMatches = true;

      if (Array.isArray(cachedAudit.legs) && cachedAudit.legs.length > 0) {
        const cachedPropIds = new Set(
          cachedAudit.legs.map((l: any) => l.prop_id || l.propId),
        );
        cacheMatches =
          requestedPropIds.size === cachedPropIds.size &&
          [...requestedPropIds].every((id) => cachedPropIds.has(id));
      } else if (
        Array.isArray(cachedAudit.correlationAudit || cachedAudit.correlation_audit)
      ) {
        const auditList =
          cachedAudit.correlationAudit || cachedAudit.correlation_audit;
        if (auditList.length > 0) {
          const cachedAuditPropIds = new Set<string>();
          for (const item of auditList) {
            const a = item.legAPropId || item.leg_a_prop_id;
            const b = item.legBPropId || item.leg_b_prop_id;
            if (a) cachedAuditPropIds.add(a);
            if (b) cachedAuditPropIds.add(b);
          }
          if (cachedAuditPropIds.size > 0) {
            cacheMatches = [...requestedPropIds].every((id) =>
              cachedAuditPropIds.has(id),
            );
          }
        }
      }

      if (cacheMatches) {
        const responsePayload = normalizeSgpPriceResponse(
          cachedAudit,
          eventId,
          sportKey,
        );

        return NextResponse.json(responsePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=45, stale-while-revalidate=15",
          },
        });
      }
    }

    // Heuristic Fallback calculation
    const calculated = calculateParlaySlip(legs);

    const responsePayload: SgpPriceResponse = {
      eventId,
      sportKey,
      unadjustedFairProbability: calculated.combinedFairProbability,
      sgpFairProbability: calculated.sgpFairProbability || calculated.combinedFairProbability,
      sgpDecimalOdds: calculated.combinedDecimalOdds,
      sgpAmericanOdds: calculated.combinedAmericanOdds,
      hasPositiveSynergy: calculated.hasPositiveSynergy || false,
      correlationAudit: calculated.sgpCorrelationAudit || [],
      isSameGameParlay: true,
      source: "heuristic",
    };

    return NextResponse.json(responsePayload, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=45, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json(
      {
        error: {
          code: "SGP_PRICE_ERROR",
          message,
        },
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get("eventId") || searchParams.get("event_id");

  if (!eventId) {
    return NextResponse.json(
      { error: { code: "MISSING_EVENT_ID", message: "Query param eventId is required." } },
      { status: 400 },
    );
  }

  const redisClient = createRedisClient();
  try {
    if (redisClient.connect) {
      await redisClient.connect();
    }
    const raw = await redisClient.get(sgpAuditKey(eventId));
    if (!raw) {
      return NextResponse.json(
        { error: { code: "SGP_AUDIT_NOT_FOUND", message: `No SGP audit cached for event ${eventId}` } },
        { status: 404 },
      );
    }
    const envelope = JSON.parse(raw);
    const normalized = normalizeSgpPriceResponse(envelope.audit || envelope, eventId);

    return NextResponse.json(normalized, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=45, stale-while-revalidate=15",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Redis error";
    return NextResponse.json(
      { error: { code: "REDIS_ERROR", message } },
      { status: 500 },
    );
  } finally {
    try {
      redisClient.disconnect();
    } catch {}
  }
}
