"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MarketPropRow } from "@/types/market";
import type {
  ParlayLeg,
  ParlaySlip,
  SgpPriceResponse,
  SwapModalState,
} from "@/types/parlay";
import {
  type LineshopperComparisonResult,
  type SportsbookId,
} from "@/types/lineshopper";
import { compareMultiBookOdds } from "@/lib/lineshopper";
import {
  addLegToSlip,
  calculateParlaySlip,
  getEligibleSwapCandidates,
  marketPropRowToParlayLeg,
  removeLegFromSlip,
  swapLegInSlip,
  updateSlipLegOdds,
  type SgpOverridesMap,
} from "@/lib/parlay";

interface ParlayDrawerContextType {
  slip: ParlaySlip;
  isOpen: boolean;
  isDocked: boolean;
  swappedLegPropId: string | null;
  swapModal: SwapModalState;
  candidatePool: MarketPropRow[];
  eligibleSwapCandidates: MarketPropRow[];
  toastMessage: string | null;
  selectedSportsbook: SportsbookId;
  lineshopperComparison: LineshopperComparisonResult;
  setSelectedSportsbook: (bookId: SportsbookId) => void;
  addLeg: (leg: ParlayLeg) => boolean;
  addMarketProp: (prop: MarketPropRow) => boolean;
  loadPresetLegs: (legs: ParlayLeg[]) => void;
  removeLeg: (propId: string) => void;
  openSwapModal: (targetLeg: ParlayLeg) => void;
  closeSwapModal: () => void;
  confirmSwap: (targetPropId: string, replacement: MarketPropRow) => void;
  setIsOpen: (open: boolean) => void;
  setIsDocked: (docked: boolean) => void;
  setCandidatePool: (pool: MarketPropRow[]) => void;
  updateLegOdds: (propId: string, newDecimalOdds: number) => void;
  clearSlip: () => void;
}

const ParlayDrawerContext = createContext<ParlayDrawerContextType | null>(null);

export function ParlayDrawerProvider({
  children,
  initialCandidates = [],
}: {
  children: React.ReactNode;
  initialCandidates?: MarketPropRow[];
}) {
  const [slip, setSlip] = useState<ParlaySlip>(() => calculateParlaySlip([]));
  const [isOpen, setIsOpen] = useState(false);
  const [isDocked, setIsDocked] = useState(false);
  const [swappedLegPropId, setSwappedLegPropId] = useState<string | null>(null);
  const [swapModal, setSwapModal] = useState<SwapModalState>({
    isOpen: false,
    targetLeg: null,
  });
  const [candidatePool, setCandidatePool] = useState<MarketPropRow[]>(initialCandidates);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [selectedSportsbook, setSelectedSportsbookState] = useState<SportsbookId>("fanduel");
  const userHasExplicitlySelectedRef = useRef(false);

  const [sgpOverrides, setSgpOverrides] = useState<SgpOverridesMap>({});
  const sgpOverridesRef = useRef<SgpOverridesMap>({});
  sgpOverridesRef.current = sgpOverrides;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((curr) => (curr === msg ? null : curr));
    }, 3000);
  }, []);

  const setSelectedSportsbook = useCallback((bookId: SportsbookId) => {
    userHasExplicitlySelectedRef.current = true;
    setSelectedSportsbookState(bookId);
  }, []);

  // Compute live lineshopper multi-sportsbook pricing
  const lineshopperComparison = useMemo(() => {
    return compareMultiBookOdds(slip.legs, {
      selectedSportsbook,
    });
  }, [slip.legs, selectedSportsbook]);

  // Default to Best Value Book upon price calculation, or fall back to an available book if selected book becomes unavailable
  useEffect(() => {
    const currentPricing = lineshopperComparison.bookmakers[selectedSportsbook];
    const isCurrentUnavailable = currentPricing && !currentPricing.isAvailable;

    if (isCurrentUnavailable) {
      const fallbackBook =
        lineshopperComparison.bestValueBookId ??
        lineshopperComparison.bookmakerList.find((b) => b.isAvailable)?.sportsbookId;
      if (fallbackBook && fallbackBook !== selectedSportsbook) {
        setSelectedSportsbookState(fallbackBook);
      }
    } else if (
      !userHasExplicitlySelectedRef.current &&
      lineshopperComparison.bestValueBookId &&
      lineshopperComparison.bestValueBookId !== selectedSportsbook
    ) {
      setSelectedSportsbookState(lineshopperComparison.bestValueBookId);
    }
  }, [lineshopperComparison, selectedSportsbook]);

  const addLeg = useCallback(
    (newLeg: ParlayLeg): boolean => {
      const result = addLegToSlip(slip, newLeg, sgpOverridesRef.current);
      if (result.error) {
        showToast(result.error);
        return false;
      }
      setSlip(result.slip);
      setIsOpen(true);
      setIsDocked(false);
      return true;
    },
    [slip, showToast],
  );

  const addMarketProp = useCallback(
    (prop: MarketPropRow): boolean => {
      const leg = marketPropRowToParlayLeg(prop);
      return addLeg(leg);
    },
    [addLeg],
  );

  const loadPresetLegs = useCallback((legs: ParlayLeg[]) => {
    const newSlip = calculateParlaySlip(legs, sgpOverridesRef.current);
    setSlip(newSlip);
    setIsOpen(true);
    setIsDocked(false);
  }, []);

  const removeLeg = useCallback((propId: string) => {
    setSlip((currSlip) => removeLegFromSlip(currSlip, propId, sgpOverridesRef.current));
  }, []);

  const openSwapModal = useCallback((targetLeg: ParlayLeg) => {
    setSwapModal({
      isOpen: true,
      targetLeg,
    });
  }, []);

  const closeSwapModal = useCallback(() => {
    setSwapModal({
      isOpen: false,
      targetLeg: null,
    });
  }, []);

  const confirmSwap = useCallback(
    (targetPropId: string, replacement: MarketPropRow) => {
      const replacementLeg = marketPropRowToParlayLeg(replacement);
      setSlip((currSlip) =>
        swapLegInSlip(currSlip, targetPropId, replacementLeg, sgpOverridesRef.current),
      );

      // Trigger green highlight flash on swapped leg row
      setSwappedLegPropId(replacement.propId);
      setTimeout(() => {
        setSwappedLegPropId((curr) => (curr === replacement.propId ? null : curr));
      }, 1800);

      closeSwapModal();
    },
    [closeSwapModal],
  );

  const updateLegOdds = useCallback((propId: string, newDecimalOdds: number) => {
    setSlip((currSlip) =>
      updateSlipLegOdds(currSlip, propId, newDecimalOdds, sgpOverridesRef.current),
    );
  }, []);

  const clearSlip = useCallback(() => {
    userHasExplicitlySelectedRef.current = false;
    setSgpOverrides({});
    sgpOverridesRef.current = {};
    setSlip(calculateParlaySlip([]));
    setSelectedSportsbookState("fanduel");
  }, []);

  // Async SGP resolution when same-game clusters exist
  useEffect(() => {
    const legsByEvent = new Map<string, ParlayLeg[]>();
    for (const leg of slip.legs) {
      const list = legsByEvent.get(leg.eventId) ?? [];
      list.push(leg);
      legsByEvent.set(leg.eventId, list);
    }

    const sgpClusters: { eventId: string; sportKey: string; legs: ParlayLeg[] }[] = [];
    for (const [eventId, eventLegs] of legsByEvent.entries()) {
      if (eventLegs.length >= 2) {
        sgpClusters.push({ eventId, sportKey: eventLegs[0].sportKey, legs: eventLegs });
      }
    }

    // Clean up obsolete SGP overrides when an event drops below 2 legs
    const activeClusterEventIds = new Set(sgpClusters.map((c) => c.eventId));
    const currentOverrideKeys = Object.keys(sgpOverridesRef.current);
    const obsoleteKeys = currentOverrideKeys.filter((k) => !activeClusterEventIds.has(k));

    if (obsoleteKeys.length > 0) {
      const cleanedOverrides: SgpOverridesMap = { ...sgpOverridesRef.current };
      for (const k of obsoleteKeys) {
        delete cleanedOverrides[k];
      }
      sgpOverridesRef.current = cleanedOverrides;
      setSgpOverrides(cleanedOverrides);
      setSlip((currSlip) => calculateParlaySlip(currSlip.legs, cleanedOverrides));
    }

    if (sgpClusters.length === 0) {
      return;
    }

    let isMounted = true;

    for (const cluster of sgpClusters) {
      fetch("/api/sgp/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: cluster.eventId,
          sportKey: cluster.sportKey,
          legs: cluster.legs,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: SgpPriceResponse | null) => {
          if (!isMounted || !data) return;

          const nextOverrides: SgpOverridesMap = {
            ...sgpOverridesRef.current,
            [cluster.eventId]: {
              sgpFairProbability: data.sgpFairProbability,
              hasPositiveSynergy: data.hasPositiveSynergy,
              correlationAudit: data.correlationAudit,
            },
          };
          sgpOverridesRef.current = nextOverrides;
          setSgpOverrides(nextOverrides);
          setSlip((currSlip) => calculateParlaySlip(currSlip.legs, nextOverrides));
        })
        .catch((err) => {
          console.warn("SGP resolution fetch error:", err);
        });
    }

    return () => {
      isMounted = false;
    };
  }, [slip.legs]);

  // Listen for live SSE odds updates on any leg currently in the slip
  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) {
      return;
    }

    let eventSource: EventSource | null = null;
    let isMounted = true;

    try {
      eventSource = new EventSource("/api/stream/odds?sport=all");

      const handleDelta = (raw: string) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(raw);
          const deltas: { propId: string; newOdds: number }[] = [];
          if (payload.propId && payload.decimalOdds) {
            deltas.push({ propId: payload.propId, newOdds: parseFloat(payload.decimalOdds) });
          } else if (payload.prop_id && payload.decimal_odds) {
            deltas.push({ propId: payload.prop_id, newOdds: parseFloat(payload.decimal_odds) });
          } else if (Array.isArray(payload.quotes)) {
            for (const q of payload.quotes) {
              const pid = q.propId || q.prop_id;
              const odds = q.decimalOdds || q.decimal_odds;
              if (pid && odds) {
                deltas.push({ propId: pid, newOdds: parseFloat(odds) });
              }
            }
          }

          if (deltas.length > 0) {
            setSlip((currSlip) => {
              let updated = currSlip;
              for (const d of deltas) {
                updated = updateSlipLegOdds(
                  updated,
                  d.propId,
                  d.newOdds,
                  sgpOverridesRef.current,
                );
              }
              return updated;
            });
          }
        } catch {
          // Ignore parse errors safely
        }
      };

      eventSource.onmessage = (e) => handleDelta(e.data);
      eventSource.addEventListener("odds_delta", (e) => handleDelta(e.data));
    } catch {
      // Ignore instantiation errors safely
    }

    return () => {
      isMounted = false;
      if (eventSource) eventSource.close();
    };
  }, []);

  // Compute eligible swap candidates whenever modal target changes
  const eligibleSwapCandidates = useMemo(() => {
    if (!swapModal.targetLeg) return [];
    return getEligibleSwapCandidates(
      swapModal.targetLeg,
      candidatePool,
      slip.legs,
    );
  }, [swapModal.targetLeg, candidatePool, slip.legs]);

  const value = useMemo(
    () => ({
      slip,
      isOpen,
      isDocked,
      swappedLegPropId,
      swapModal,
      candidatePool,
      eligibleSwapCandidates,
      toastMessage,
      selectedSportsbook,
      lineshopperComparison,
      setSelectedSportsbook,
      addLeg,
      addMarketProp,
      loadPresetLegs,
      removeLeg,
      openSwapModal,
      closeSwapModal,
      confirmSwap,
      setIsOpen,
      setIsDocked,
      setCandidatePool,
      updateLegOdds,
      clearSlip,
    }),
    [
      slip,
      isOpen,
      isDocked,
      swappedLegPropId,
      swapModal,
      candidatePool,
      eligibleSwapCandidates,
      toastMessage,
      selectedSportsbook,
      lineshopperComparison,
      setSelectedSportsbook,
      addLeg,
      addMarketProp,
      loadPresetLegs,
      removeLeg,
      openSwapModal,
      closeSwapModal,
      confirmSwap,
      updateLegOdds,
      clearSlip,
    ],
  );

  return (
    <ParlayDrawerContext.Provider value={value}>
      {children}
    </ParlayDrawerContext.Provider>
  );
}

export function useParlayDrawer(): ParlayDrawerContextType {
  const context = useContext(ParlayDrawerContext);
  if (!context) {
    throw new Error("useParlayDrawer must be used within a ParlayDrawerProvider");
  }
  return context;
}
