import { INTEGRATED_SPORTSBOOKS, type SportsbookId } from "@/types/lineshopper";
import type {
  QuickPickErrorCode,
  QuickPickLeg,
  QuickPickPayload,
  QuickPickSerializeRequest,
  QuickPickSerializeResponse,
} from "@/types/quickpick";
import { decimalToAmerican } from "./math";

export const QUICKPICK_BASE_URL = "https://quickpick.pikkit.com/v1/betslip";
export const MIN_QUICKPICK_LEGS = 1;
export const MAX_QUICKPICK_LEGS = 8;
export const MAX_GUARDED_EV_THRESHOLD = 0.10;

export const SPORTSBOOK_DEEP_LINK_CONFIG: Record<
  SportsbookId,
  { schemePrefix: string; webFallback: string }
> = {
  fanduel: {
    schemePrefix: "fanduel://sportsbook/betslip?quickpick=",
    webFallback: "https://sportsbook.fanduel.com",
  },
  draftkings: {
    schemePrefix: "draftkings://sportsbook/betslip?quickpick=",
    webFallback: "https://sportsbook.draftkings.com",
  },
  betmgm: {
    schemePrefix: "betmgm://sportsbook/betslip?quickpick=",
    webFallback: "https://sports.betmgm.com",
  },
  caesars: {
    schemePrefix: "williamhill://sportsbook/betslip?quickpick=",
    webFallback: "https://www.caesars.com/sportsbook-and-casino",
  },
  fanatics: {
    schemePrefix: "fanatics://sportsbook/betslip?quickpick=",
    webFallback: "https://sportsbook.fanatics.com",
  },
  sleeper: {
    schemePrefix: "sleeper://picks/betslip?quickpick=",
    webFallback: "https://sleeper.com",
  },
};

export class QuickPickValidationError extends Error {
  readonly code: QuickPickErrorCode;
  readonly statusCode: number;

  constructor(code: QuickPickErrorCode, message: string, statusCode: number = 400) {
    super(message);
    this.name = "QuickPickValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Encodes a string into URL-safe base64 without padding (RFC 4648 §5).
 */
export function toBase64Url(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf-8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes a URL-safe base64 string into UTF-8.
 */
export function fromBase64Url(base64url: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64url, "base64url").toString("utf-8");
  }
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Builds the canonical Pikkit QuickPick smart-link URL.
 */
export function buildQuickPickUrl(encodedData: string): string {
  return `${QUICKPICK_BASE_URL}?data=${encodedData}`;
}

/**
 * Generates the deep link for a specific retail sportsbook app.
 */
export function generateSportsbookDeepLink(sportsbook: SportsbookId, encodedData: string): string {
  const config = SPORTSBOOK_DEEP_LINK_CONFIG[sportsbook];
  if (!config) {
    return `https://quickpick.pikkit.com/v1/betslip?data=${encodedData}`;
  }
  return `${config.schemePrefix}${encodedData}`;
}

/**
 * Gets the standard web fallback URL for a sportsbook.
 */
export function getSportsbookFallbackUrl(sportsbook: SportsbookId): string {
  const config = SPORTSBOOK_DEEP_LINK_CONFIG[sportsbook];
  return config ? config.webFallback : "https://quickpick.pikkit.com";
}

/**
 * Checks whether a sportsbook identifier is in the supported integrated books list.
 */
export function isSupportedSportsbook(sportsbook: string): sportsbook is SportsbookId {
  return (INTEGRATED_SPORTSBOOKS as readonly string[]).includes(sportsbook);
}

/**
 * Formats an event identifier to ensure upstream provider prefixing (`papi_`).
 */
export function formatExternalEventId(eventId?: string | null, sportKey?: string | null): string {
  if (!eventId || typeof eventId !== "string" || eventId.trim() === "") {
    return sportKey ? `papi_${sportKey}_unknown` : "papi_unknown";
  }
  const trimmed = eventId.trim();
  if (trimmed.startsWith("papi_")) {
    return trimmed;
  }
  let cleanId = trimmed.replace(/^evt-/, "");
  if (sportKey && (cleanId.startsWith(`${sportKey}-`) || cleanId.startsWith(`${sportKey}_`))) {
    cleanId = cleanId.slice(sportKey.length + 1);
  }
  return sportKey ? `papi_${sportKey}_${cleanId}` : `papi_${cleanId}`;
}

/**
 * Validates request payload against domain boundaries and edge cases.
 */
export function validateQuickPickRequest(request: QuickPickSerializeRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new QuickPickValidationError(
      "INVALID_LEG_DATA",
      "Request body must be a valid object.",
    );
  }

  if (!Array.isArray(request.legs) || request.legs.length === 0) {
    throw new QuickPickValidationError(
      "EMPTY_PARLAY_LEGS",
      "At least one leg is required.",
    );
  }

  if (request.legs.length > MAX_QUICKPICK_LEGS) {
    throw new QuickPickValidationError(
      "MAX_LEGS_EXCEEDED",
      "Maximum 8 legs allowed per QuickPick slip.",
    );
  }

  if (!request.sportsbook || !isSupportedSportsbook(String(request.sportsbook))) {
    throw new QuickPickValidationError(
      "UNSUPPORTED_SPORTSBOOK",
      `Sportsbook '${request.sportsbook}' is not supported.`,
    );
  }

  if (request.stake !== undefined && request.stake !== null) {
    const numStake = Number(request.stake);
    if (!Number.isFinite(numStake) || numStake <= 0) {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        "Stake must be a positive finite number.",
      );
    }
  }

  for (let i = 0; i < request.legs.length; i++) {
    const leg = request.legs[i];
    if (!leg || typeof leg !== "object") {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        `Leg at index ${i} is not a valid leg object.`,
      );
    }

    const propId = (leg as any).propId || (leg as any).id;
    if (!propId || typeof propId !== "string" || propId.trim() === "") {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        `Leg at index ${i} is missing required field: propId.`,
      );
    }

    const marketKey = (leg as any).marketKey || (leg as any).marketType;
    if (!marketKey || typeof marketKey !== "string" || marketKey.trim() === "") {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        `Leg '${propId}' is missing required field: marketKey.`,
      );
    }

    const playerName = (leg as any).playerName;
    if (!playerName || typeof playerName !== "string" || playerName.trim() === "") {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        `Leg '${propId}' is missing required field: playerName.`,
      );
    }

    const selection = (leg as any).selection;
    if (!selection || !["OVER", "UNDER", "YES"].includes(String(selection).toUpperCase())) {
      throw new QuickPickValidationError(
        "INVALID_LEG_DATA",
        `Leg '${propId}' has invalid selection '${selection}'. Expected OVER, UNDER, or YES.`,
      );
    }

    // Decimal odds range enforcement (D >= 1.01 and D <= 9999.9999)
    const rawOdds = (leg as any).offeredDecimalOdds ?? (leg as any).odds;
    if (rawOdds !== undefined && rawOdds !== null) {
      const dec = typeof rawOdds === "number" ? rawOdds : parseFloat(String(rawOdds));
      if (!Number.isFinite(dec) || dec < 1.01 || dec > 9999.9999) {
        throw new QuickPickValidationError(
          "INVALID_LEG_DATA",
          `Leg '${propId}' has invalid decimal odds '${rawOdds}'. Must be between 1.01 and 9999.9999.`,
        );
      }
    }

    // Circuit breaker: Outlier Stale Line Check (>10.0% EV or status === SUSPECT_STALE_LINE)
    const isSuspect =
      Boolean((leg as any).isSuspectStaleLine) ||
      (leg as any).status === "SUSPECT_STALE_LINE";
    const evVal = parseFloat(String((leg as any).guardedEv ?? "0"));
    if (isSuspect || (!isNaN(evVal) && evVal > MAX_GUARDED_EV_THRESHOLD)) {
      throw new QuickPickValidationError(
        "SUSPECT_STALE_LINE",
        `Leg '${propId}' contains suspect stale lines (>10.0% EV).`,
      );
    }
  }
}

/**
 * Pure serialization logic converting parlay legs and target bookmaker into a QuickPick payload.
 */
export function serializeQuickPickPayload(
  request: QuickPickSerializeRequest,
): Omit<QuickPickSerializeResponse, "executionLatencyMs"> {
  validateQuickPickRequest(request);

  const targetBook = request.sportsbook as SportsbookId;

  const serializedLegs: QuickPickLeg[] = request.legs.map((leg) => {
    const rawLeg = leg as any;
    const propId = String(rawLeg.propId || rawLeg.id);
    const marketType = String(rawLeg.marketKey || rawLeg.marketType);
    const eventId = formatExternalEventId(rawLeg.eventId, rawLeg.sportKey);
    const selection = String(rawLeg.selection).toUpperCase() as QuickPickLeg["selection"];
    const lineValue =
      rawLeg.lineValue !== undefined && rawLeg.lineValue !== null
        ? Number(rawLeg.lineValue)
        : null;

    // Resolve book-specific decimal odds
    let oddsStr: string;
    let americanOdds: number | undefined = rawLeg.offeredAmericanOdds;

    const bookQuote = rawLeg.sportsbookQuotes?.[targetBook];
    if (bookQuote && bookQuote.decimalOdds) {
      const dec =
        typeof bookQuote.decimalOdds === "number"
          ? bookQuote.decimalOdds
          : parseFloat(bookQuote.decimalOdds);
      if (!isNaN(dec) && dec >= 1.01) {
        oddsStr = dec.toFixed(4);
        americanOdds =
          typeof bookQuote.americanOdds === "number"
            ? bookQuote.americanOdds
            : decimalToAmerican(dec);
      } else {
        oddsStr = String(rawLeg.offeredDecimalOdds || "2.0000");
      }
    } else if (rawLeg.offeredDecimalOdds) {
      const dec =
        typeof rawLeg.offeredDecimalOdds === "number"
          ? rawLeg.offeredDecimalOdds
          : parseFloat(rawLeg.offeredDecimalOdds);
      oddsStr = !isNaN(dec) ? dec.toFixed(4) : String(rawLeg.offeredDecimalOdds);
    } else if (rawLeg.odds) {
      oddsStr = String(rawLeg.odds);
    } else {
      oddsStr = "2.0000";
    }

    return {
      eventId,
      propId,
      playerName: rawLeg.playerName,
      marketType,
      marketKey: marketType,
      selection,
      lineValue,
      odds: oddsStr,
      americanOdds,
      teamAbbreviation: rawLeg.teamAbbreviation,
      sportKey: rawLeg.sportKey,
      matchup: rawLeg.matchup,
    };
  });

  // Calculate combined decimal odds
  let combinedOdds = 1.0;
  for (const l of serializedLegs) {
    const dec = parseFloat(l.odds) || 1.0;
    combinedOdds *= dec;
  }
  const totalOddsStr = Math.max(1.01, combinedOdds).toFixed(4);
  const totalAmerican = decimalToAmerican(Math.max(1.01, combinedOdds));

  const payload: QuickPickPayload = {
    version: "v1",
    generator: "parlaypal",
    sportsbook: targetBook,
    legs: serializedLegs,
    stake: request.stake ?? 50,
    totalOdds: totalOddsStr,
    totalAmericanOdds: totalAmerican,
    createdAt: new Date().toISOString(),
  };

  const jsonStr = JSON.stringify(payload);
  const encodedData = toBase64Url(jsonStr);
  const url = buildQuickPickUrl(encodedData);
  const universalLink = url;
  const deepLink = generateSportsbookDeepLink(targetBook, encodedData);
  const fallbackUrl = getSportsbookFallbackUrl(targetBook);

  return {
    url,
    universalLink,
    deepLink,
    fallbackUrl,
    encodedData,
    payload,
  };
}

/**
 * Deserializes an encoded data parameter back to the QuickPickPayload.
 */
export function deserializeQuickPickPayload(encodedData: string): QuickPickPayload {
  const jsonStr = fromBase64Url(encodedData);
  return JSON.parse(jsonStr) as QuickPickPayload;
}
