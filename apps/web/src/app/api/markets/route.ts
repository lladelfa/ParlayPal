import { NextResponse } from "next/server";
import { getMarketBrowserFeed, filterMarketProps } from "@/lib/markets";
import type {
  DateWindowFilter,
  MarketFilter,
  SportFilter,
} from "@/types/market";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const sport = (searchParams.get("sport") ?? "all") as SportFilter;
    const date = (searchParams.get("date") ?? "all") as DateWindowFilter;
    const market = (searchParams.get("market") ?? "all") as MarketFilter;
    const q = searchParams.get("q") ?? undefined;

    const feed = await getMarketBrowserFeed(sport);
    const filteredProps = filterMarketProps(feed.props, {
      sport,
      dateWindow: date,
      market,
      query: q,
    });

    const activeEventIds = new Set(filteredProps.map((p) => p.eventId));
    const filteredGames = feed.games.filter(
      (g) =>
        (sport === "all" || g.sportKey === sport) &&
        (date === "all" || g.dateWindow === date) &&
        (filteredProps.length > 0 ? activeEventIds.has(g.eventId) : false),
    );

    return NextResponse.json(
      {
        ...feed,
        props: filteredProps,
        games: filteredGames,
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=45, stale-while-revalidate=15",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json(
      {
        error: {
          code: "MARKET_BROWSER_ERROR",
          message,
        },
      },
      { status: 500 },
    );
  }
}
