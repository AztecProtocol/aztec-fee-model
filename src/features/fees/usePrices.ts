"use client";
import { useCallback, useEffect, useState } from "react";

export interface ProtocolState {
  manaTarget: number | null;
  manaLimit: number | null;
  provingCostPerManaWei: number | null;
  checkpointRewardAZTEC: number | null;
  sequencerBps: number | null;
  slotDurationSec: number | null;
  epochDurationSlots: number | null;
  proofSubmissionEpochs: number | null;
  ethPerFeeAssetE12: number | null;
  l1BaseFeeWei: number | null;
  l1BlobFeeWei: number | null;
  manaMinFeeWeiETH: number | null;
  manaMinFeeWeiFeeAsset: number | null;
}

export interface PriceData {
  timestamp: string;
  ethPriceUSD: number | null;
  aztecPriceUSD: number | null;
  gasPriceGwei: { current: number | null; avg30d: number | null };
  blobGasPriceGwei: number | null;
  protocolState?: ProtocolState;
  notes: string[];
  errors: string[];
}

interface Cached {
  data: PriceData;
  cachedAt: number;
}

const CACHE_KEY = "aztecDashboard.prices.v2";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function readCache(): Cached | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (!parsed?.data || typeof parsed.cachedAt !== "number") return null;
    if (Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(data: PriceData, cachedAt: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ data, cachedAt }));
  } catch {
    // Storage full or disabled — silently ignore.
  }
}

export function usePrices() {
  const [data, setData] = useState<PriceData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [cacheHit, setCacheHit] = useState<boolean>(false);

  const fetchPrices = useCallback(async (force: boolean) => {
    if (!force) {
      const cached = readCache();
      if (cached) {
        setData(cached.data);
        setLastFetched(new Date(cached.cachedAt));
        setCacheHit(true);
        return;
      }
    }
    setLoading(true);
    try {
      const r = await fetch("/api/prices", { cache: "no-store" });
      const fresh = (await r.json()) as PriceData;
      const now = Date.now();
      setData(fresh);
      setLastFetched(new Date(now));
      setCacheHit(false);
      writeCache(fresh, now);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setData({
        timestamp: new Date().toISOString(),
        ethPriceUSD: null,
        aztecPriceUSD: null,
        gasPriceGwei: { current: null, avg30d: null },
        blobGasPriceGwei: null,
        notes: [],
        errors: [`fetch failed: ${errMsg}`],
      });
      setLastFetched(new Date());
      setCacheHit(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrices(false);
  }, [fetchPrices]);

  const refresh = useCallback(() => fetchPrices(true), [fetchPrices]);

  return { data, loading, lastFetched, cacheHit, refresh };
}
