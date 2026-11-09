"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MarketPropRow } from "@/types/market";
import type { ParlayLeg, ParlaySlip, SwapModalState } from "@/types/parlay";
import {
  addLegToSlip,
  calculateParlaySlip,
  getEligibleSwapCandidates,
  marketPropRowToParlayLeg,
  removeLegFromSlip,
  swapLegInSlip,
  updateSlipLegOdds,
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

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((curr) => (curr === msg ? null : curr));
    }, 3000);
  }, []);

  const addLeg = useCallback(
    (newLeg: ParlayLeg): boolean => {
      const result = addLegToSlip(slip, newLeg);
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
    const newSlip = calculateParlaySlip(legs);
    setSlip(newSlip);
    setIsOpen(true);
    setIsDocked(false);
  }, []);

  const removeLeg = useCallback((propId: string) => {
    setSlip((currSlip) => removeLegFromSlip(currSlip, propId));
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
      setSlip((currSlip) => swapLegInSlip(currSlip, targetPropId, replacementLeg));

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
    setSlip((currSlip) => updateSlipLegOdds(currSlip, propId, newDecimalOdds));
  }, []);

  const clearSlip = useCallback(() => {
    setSlip(calculateParlaySlip([]));
  }, []);

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
                updated = updateSlipLegOdds(updated, d.propId, d.newOdds);
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
