import { NextResponse } from "next/server";
import { QuickPickValidationError, serializeQuickPickPayload } from "@/lib/quickpick";
import type { QuickPickSerializeRequest, QuickPickSerializeResponse } from "@/types/quickpick";

export const dynamic = "force-dynamic";

/**
 * POST /api/quickpick/serialize
 *
 * Serializes active Parlay Drawer legs and target sportsbook into the universal
 * Pikkit QuickPick smart-link URL schema, generating universal web links and native
 * retail sportsbook deep links with sub-50ms latency. Unauthenticated/guest accessible.
 */
export async function POST(req: Request) {
  const startTime = performance.now();

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

    const serialized = serializeQuickPickPayload(body as QuickPickSerializeRequest);
    const durationMs = Number((performance.now() - startTime).toFixed(2));

    const responsePayload: QuickPickSerializeResponse = {
      ...serialized,
      executionLatencyMs: durationMs,
    };

    return NextResponse.json(responsePayload, {
      status: 200,
      headers: {
        "Server-Timing": `serialize;dur=${durationMs}`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: any) {
    if (err instanceof QuickPickValidationError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
          },
        },
        { status: err.statusCode },
      );
    }

    console.error("Unexpected error in /api/quickpick/serialize:", err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error during QuickPick serialization.",
        },
      },
      { status: 500 },
    );
  }
}
