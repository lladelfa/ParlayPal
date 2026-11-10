import { describe, expect, it } from "vitest";
import type { ParlayLeg } from "@/types/parlay";
import type { SportsbookId } from "@/types/lineshopper";
import {
  buildQuickPickUrl,
  deserializeQuickPickPayload,
  formatExternalEventId,
  fromBase64Url,
  generateSportsbookDeepLink,
  getSportsbookFallbackUrl,
  QuickPickValidationError,
  serializeQuickPickPayload,
  toBase64Url,
  validateQuickPickRequest,
} from "./quickpick";

function createMockLeg(
  propId: string,
  playerName: string,
  marketKey: string = "player_anytime_td",
  overrides?: Record<string, any>,
): ParlayLeg {
  return {
    propId,
    eventId: `evt-${propId}`,
    sportKey: "nfl",
    playerName,
    teamAbbreviation: "BAL",
    matchup: "BAL @ PIT",
    marketKey,
    marketDisplay: "Anytime Touchdown",
    selection: "OVER",
    lineValue: 0.5,
    offeredDecimalOdds: "2.0000",
    offeredAmericanOdds: 100,
    fairProbability: "0.50000",
    guardedEv: "0.0200",
    ...overrides,
  };
}

describe("QuickPick Serialization Engine", () => {
  describe("Base64URL encoding & decoding roundtrip", () => {
    it("encodes and decodes utf-8 and JSON strings without data loss", () => {
      const sample = JSON.stringify({
        version: "v1",
        generator: "parlaypal",
        hello: "world & special <chars> + = /",
        unicode: "⚡🏈🚀",
      });

      const encoded = toBase64Url(sample);
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect(encoded).not.toContain("=");

      const decoded = fromBase64Url(encoded);
      expect(decoded).toBe(sample);
      expect(JSON.parse(decoded)).toEqual(JSON.parse(sample));
    });
  });

  describe("Deep Link & Smart Link URL construction", () => {
    it("builds the universal QuickPick smart link URL format", () => {
      const dummyData = "eyJmb28iOiJiYXIifQ";
      const url = buildQuickPickUrl(dummyData);
      expect(url).toBe("https://quickpick.pikkit.com/v1/betslip?data=eyJmb28iOiJiYXIifQ");
    });

    it("generates correct scheme deep links and web fallbacks for all supported sportsbooks", () => {
      const dummyData = "testDataPayload123";
      const testCases: {
        book: SportsbookId;
        expectedSchemePrefix: string;
        expectedFallback: string;
      }[] = [
        {
          book: "fanduel",
          expectedSchemePrefix: "fanduel://sportsbook/betslip?quickpick=",
          expectedFallback: "https://sportsbook.fanduel.com",
        },
        {
          book: "draftkings",
          expectedSchemePrefix: "draftkings://sportsbook/betslip?quickpick=",
          expectedFallback: "https://sportsbook.draftkings.com",
        },
        {
          book: "betmgm",
          expectedSchemePrefix: "betmgm://sportsbook/betslip?quickpick=",
          expectedFallback: "https://sports.betmgm.com",
        },
        {
          book: "caesars",
          expectedSchemePrefix: "williamhill://sportsbook/betslip?quickpick=",
          expectedFallback: "https://www.caesars.com/sportsbook-and-casino",
        },
        {
          book: "fanatics",
          expectedSchemePrefix: "fanatics://sportsbook/betslip?quickpick=",
          expectedFallback: "https://sportsbook.fanatics.com",
        },
        {
          book: "sleeper",
          expectedSchemePrefix: "sleeper://picks/betslip?quickpick=",
          expectedFallback: "https://sleeper.com",
        },
      ];

      for (const tc of testCases) {
        const deepLink = generateSportsbookDeepLink(tc.book, dummyData);
        expect(deepLink).toBe(`${tc.expectedSchemePrefix}${dummyData}`);

        const fallback = getSportsbookFallbackUrl(tc.book);
        expect(fallback).toBe(tc.expectedFallback);
      }
    });
  });

  describe("serializeQuickPickPayload", () => {
    it("serializes multi-leg parlay into compliant QuickPick payload and links (Happy Path)", () => {
      const leg1 = createMockLeg("leg-henry", "Derrick Henry", "player_anytime_td", {
        eventId: "papi_nfl_1001",
        lineValue: 0.5,
        offeredDecimalOdds: "2.0800",
        offeredAmericanOdds: 108,
        teamAbbreviation: "BAL",
        matchup: "BAL @ PIT",
      });
      const leg2 = createMockLeg("leg-amon", "Amon-Ra St. Brown", "player_receptions", {
        eventId: "evt-det-chi",
        lineValue: 6.5,
        selection: "OVER",
        offeredDecimalOdds: "2.5000",
        offeredAmericanOdds: 150,
        teamAbbreviation: "DET",
        matchup: "DET @ CHI",
      });

      const response = serializeQuickPickPayload({
        legs: [leg1, leg2],
        sportsbook: "fanduel",
        stake: 50,
      });

      expect(response.url).toMatch(/^https:\/\/quickpick\.pikkit\.com\/v1\/betslip\?data=/);
      expect(response.universalLink).toBe(response.url);
      expect(response.deepLink).toMatch(/^fanduel:\/\/sportsbook\/betslip\?quickpick=/);
      expect(response.fallbackUrl).toBe("https://sportsbook.fanduel.com");
      expect(response.encodedData).toBeTruthy();

      // Verify payload contents
      const payload = response.payload;
      expect(payload.version).toBe("v1");
      expect(payload.generator).toBe("parlaypal");
      expect(payload.sportsbook).toBe("fanduel");
      expect(payload.stake).toBe(50);
      expect(payload.legs).toHaveLength(2);

      // Verify leg 1 telemetry
      expect(payload.legs[0].eventId).toBe("papi_nfl_1001");
      expect(payload.legs[0].propId).toBe("leg-henry");
      expect(payload.legs[0].playerName).toBe("Derrick Henry");
      expect(payload.legs[0].marketType).toBe("player_anytime_td");
      expect(payload.legs[0].selection).toBe("OVER");
      expect(payload.legs[0].lineValue).toBe(0.5);
      expect(payload.legs[0].odds).toBe("2.0800");

      // Verify leg 2 telemetry (eventId formatted with papi_ prefix)
      expect(payload.legs[1].eventId).toBe("papi_nfl_det-chi");
      expect(payload.legs[1].playerName).toBe("Amon-Ra St. Brown");
      expect(payload.legs[1].lineValue).toBe(6.5);

      // Verify roundtrip deserialization
      const decodedPayload = deserializeQuickPickPayload(response.encodedData);
      expect(decodedPayload.generator).toBe("parlaypal");
      expect(decodedPayload.legs).toHaveLength(2);
      expect(decodedPayload.legs[0].playerName).toBe("Derrick Henry");
    });

    it("serializes single-leg bet for DraftKings", () => {
      const leg = createMockLeg("leg-luka", "Luka Doncic", "player_points", {
        eventId: "papi_nba_2001",
        sportKey: "nba",
        lineValue: 31.5,
        selection: "OVER",
        offeredDecimalOdds: "1.9091",
        offeredAmericanOdds: -110,
        teamAbbreviation: "DAL",
      });

      const response = serializeQuickPickPayload({
        legs: [leg],
        sportsbook: "draftkings",
      });

      expect(response.url).toMatch(/^https:\/\/quickpick\.pikkit\.com\/v1\/betslip\?data=/);
      expect(response.deepLink).toMatch(/^draftkings:\/\/sportsbook\/betslip\?quickpick=/);
      expect(response.fallbackUrl).toBe("https://sportsbook.draftkings.com");
      expect(response.payload.legs).toHaveLength(1);
      expect(response.payload.legs[0].playerName).toBe("Luka Doncic");
      expect(response.payload.legs[0].lineValue).toBe(31.5);
    });

    it("uses sportsbook-specific quotes when available on the leg", () => {
      const leg = createMockLeg("leg-quote", "Christian McCaffrey", "player_rush_yds", {
        offeredDecimalOdds: "1.85",
        sportsbookQuotes: {
          draftkings: {
            sportsbook: "draftkings",
            sportsbookId: "draftkings",
            decimalOdds: 1.95,
            americanOdds: -105,
            isAvailable: true,
          },
          fanduel: {
            sportsbook: "fanduel",
            sportsbookId: "fanduel",
            decimalOdds: 1.91,
            americanOdds: -110,
            isAvailable: true,
          },
        },
      });

      const dkResponse = serializeQuickPickPayload({
        legs: [leg],
        sportsbook: "draftkings",
      });
      expect(dkResponse.payload.legs[0].odds).toBe("1.9500");

      const fdResponse = serializeQuickPickPayload({
        legs: [leg],
        sportsbook: "fanduel",
      });
      expect(fdResponse.payload.legs[0].odds).toBe("1.9100");
    });
  });

  describe("Validation & Error Matrix", () => {
    it("throws EMPTY_PARLAY_LEGS when legs array is empty", () => {
      expect(() =>
        validateQuickPickRequest({
          legs: [],
          sportsbook: "betmgm",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "EMPTY_PARLAY_LEGS",
          message: "At least one leg is required.",
        }),
      );
    });

    it("throws UNSUPPORTED_SPORTSBOOK when book is not supported", () => {
      const leg = createMockLeg("leg-1", "Patrick Mahomes");
      expect(() =>
        validateQuickPickRequest({
          legs: [leg],
          sportsbook: "unsupported_book",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "UNSUPPORTED_SPORTSBOOK",
          message: "Sportsbook 'unsupported_book' is not supported.",
        }),
      );
    });

    it("throws MAX_LEGS_EXCEEDED when leg count exceeds 8", () => {
      const legs = Array.from({ length: 9 }, (_, i) =>
        createMockLeg(`leg-${i + 1}`, `Player ${i + 1}`),
      );

      expect(() =>
        validateQuickPickRequest({
          legs,
          sportsbook: "caesars",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "MAX_LEGS_EXCEEDED",
          message: "Maximum 8 legs allowed per QuickPick slip.",
        }),
      );
    });

    it("throws INVALID_LEG_DATA when leg is missing propId", () => {
      const badLeg = {
        playerName: "Test Player",
        marketKey: "player_pass_yds",
        selection: "OVER",
      } as any;

      expect(() =>
        validateQuickPickRequest({
          legs: [badLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_LEG_DATA",
        }),
      );
    });

    it("throws INVALID_LEG_DATA when leg is missing marketKey", () => {
      const badLeg = {
        propId: "p1",
        playerName: "Test Player",
        selection: "OVER",
      } as any;

      expect(() =>
        validateQuickPickRequest({
          legs: [badLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_LEG_DATA",
        }),
      );
    });

    it("throws INVALID_LEG_DATA when leg has invalid selection", () => {
      const badLeg = {
        propId: "p1",
        playerName: "Test Player",
        marketKey: "player_pass_yds",
        selection: "INVALID_SELECTION",
      } as any;

      expect(() =>
        validateQuickPickRequest({
          legs: [badLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_LEG_DATA",
        }),
      );
    });

    it("throws SUSPECT_STALE_LINE when leg has guarded EV > 10.0% or suspect status", () => {
      const staleLeg = createMockLeg("leg-stale", "Suspect Player", "player_pass_yds", {
        guardedEv: "0.1500", // 15% EV > 10%
      });

      expect(() =>
        validateQuickPickRequest({
          legs: [staleLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "SUSPECT_STALE_LINE",
        }),
      );
    });

    it("throws SUSPECT_STALE_LINE when status is SUSPECT_STALE_LINE even with nominal EV", () => {
      const suspectLeg = createMockLeg("leg-suspect", "Nominal EV Suspect", "player_pass_yds", {
        guardedEv: "0.0200", // 2% nominal EV
        status: "SUSPECT_STALE_LINE" as any,
      });

      expect(() =>
        validateQuickPickRequest({
          legs: [suspectLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "SUSPECT_STALE_LINE",
        }),
      );
    });

    it("throws SUSPECT_STALE_LINE when isSuspectStaleLine flag is true with nominal EV", () => {
      const suspectLeg = createMockLeg("leg-flag", "Flagged Player", "player_rush_yds", {
        guardedEv: "0.0150",
        isSuspectStaleLine: true as any,
      });

      expect(() =>
        validateQuickPickRequest({
          legs: [suspectLeg],
          sportsbook: "draftkings",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "SUSPECT_STALE_LINE",
        }),
      );
    });

    it("throws INVALID_LEG_DATA when stake is negative or zero", () => {
      const leg = createMockLeg("leg-stake", "Stake Player");

      expect(() =>
        validateQuickPickRequest({
          legs: [leg],
          sportsbook: "fanduel",
          stake: -10,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_LEG_DATA",
          message: "Stake must be a positive finite number.",
        }),
      );
    });

    it("throws INVALID_LEG_DATA when offered decimal odds are below 1.01", () => {
      const invalidOddsLeg = createMockLeg("leg-odds", "Low Odds Player", "player_pass_yds", {
        offeredDecimalOdds: "1.0050",
      });

      expect(() =>
        validateQuickPickRequest({
          legs: [invalidOddsLeg],
          sportsbook: "fanduel",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_LEG_DATA",
        }),
      );
    });

    it("prevents duplicate sport prefixes in formatExternalEventId", () => {
      expect(formatExternalEventId("evt-nfl-1001", "nfl")).toBe("papi_nfl_1001");
      expect(formatExternalEventId("nfl_bal_pit", "nfl")).toBe("papi_nfl_bal_pit");
    });
  });
});
