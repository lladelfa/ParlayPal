import { NextResponse } from "next/server";
import { getCuratedPresetFeed } from "@/lib/presets";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const sport = searchParams.get("sport") ?? undefined;

    const feed = await getCuratedPresetFeed(sport);

    return NextResponse.json(feed, {
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
          code: "PRESET_FEED_ERROR",
          message,
        },
      },
      { status: 500 },
    );
  }
}
