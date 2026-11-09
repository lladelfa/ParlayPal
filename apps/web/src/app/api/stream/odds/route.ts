import { problemDetailsResponse } from "@/lib/errors";
import {
  createRedisSubscriber,
  formatIso8601Utc,
  normalizeSportParam,
  oddsFeedChannel,
  SUPPORTED_SPORT_KEYS,
} from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawSport =
    url.searchParams.get("sport_key") ?? url.searchParams.get("sport");
  const sport = normalizeSportParam(rawSport);

  if (!sport) {
    return problemDetailsResponse(
      400,
      "INVALID_SPORT_KEY",
      `Unsupported or missing sport_key. Expected one of: ${SUPPORTED_SPORT_KEYS.join(", ")}, or 'all'.`,
      60,
    );
  }

  const channels =
    sport === "all"
      ? SUPPORTED_SPORT_KEYS.map((k) => oddsFeedChannel(k))
      : [oddsFeedChannel(sport)];

  const subscriber = createRedisSubscriber();

  // Attach a no-op error listener so unhandled ioredis socket error events do not crash Node
  subscriber.on("error", () => {
    // Handled via try/catch during connection or stream teardown
  });

  try {
    if (typeof subscriber.connect === "function") {
      await subscriber.connect();
    }
    await subscriber.subscribe(...channels);
  } catch {
    try {
      subscriber.removeAllListeners();
      subscriber.disconnect();
    } catch {
      // Ignore cleanup errors on failed connection
    }

    return problemDetailsResponse(
      503,
      "STREAM_UNAVAILABLE",
      "Real-time odds stream is currently unavailable.",
      60,
    );
  }

  const encoder = new TextEncoder();
  let cleanedUp = false;

  const cleanup = async (
    controller?: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    if (controller) {
      try {
        controller.close();
      } catch {
        // Controller may already be closed
      }
    }

    try {
      await subscriber.unsubscribe(...channels);
    } catch {
      // Ignore unsubscribe errors during disconnect
    }

    try {
      await subscriber.quit();
    } catch {
      try {
        subscriber.disconnect();
      } catch {
        // Ignore fallback disconnect errors
      }
    } finally {
      try {
        subscriber.removeAllListeners();
      } catch {
        // Ignore listener removal errors
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const initialFrame = JSON.stringify({
        type: "connected",
        sport_key: sport,
        channels,
        channel: channels[0],
        updated_at: formatIso8601Utc(),
      });
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${initialFrame}\n\n`),
      );

      const onAbort = () => {
        void cleanup(controller);
      };

      subscriber.on("message", (incomingChannel: string, message: string) => {
        if (cleanedUp || !channels.includes(incomingChannel)) {
          return;
        }
        const sanitized = message.replace(/[\r\n]+/g, " ");
        try {
          controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
        } catch {
          void cleanup(controller);
        }
      });

      subscriber.on("end", onAbort);
      subscriber.on("close", onAbort);

      if (request.signal.aborted) {
        onAbort();
        return;
      }

      request.signal.addEventListener("abort", onAbort, { once: true });
    },
    async cancel() {
      await cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
