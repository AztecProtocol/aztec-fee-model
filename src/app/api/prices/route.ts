import { NextResponse } from "next/server";

// Etherscan V2 unified endpoint (V1 paths are being deprecated; V2 requires chainid).
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "1"; // Ethereum mainnet.

// CoinMarketCap Pro API (free "Basic" tier works for the quotes/latest endpoint).
const CMC_BASE = "https://pro-api.coinmarketcap.com";

// Fallback Ethereum JSON-RPC for blob base fee if override not provided.
const FALLBACK_ETH_RPC = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";

type PricesResponse = {
  timestamp: string;
  ethPriceUSD: number | null;
  aztecPriceUSD: number | null;
  gasPriceGwei: { current: number | null; avg30d: number | null };
  blobGasPriceGwei: number | null;
  notes: string[];
  errors: string[];
};

async function fetchJSON(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, next: { revalidate: 60 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function GET() {
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  const cmcKey = process.env.COINMARKETCAP_API_KEY;
  const aztecSymbol = process.env.AZTEC_TOKEN_SYMBOL || "AZTEC";
  const aztecCmcId = process.env.AZTEC_CMC_ID; // Optional: preferred over symbol to disambiguate.

  const out: PricesResponse = {
    timestamp: new Date().toISOString(),
    ethPriceUSD: null,
    aztecPriceUSD: null,
    gasPriceGwei: { current: null, avg30d: null },
    blobGasPriceGwei: null,
    notes: [],
    errors: [],
  };

  // ---- Prices (CoinMarketCap) ----
  if (!cmcKey) {
    out.errors.push("COINMARKETCAP_API_KEY env var is not set — skipping ETH + AZTEC price lookup");
  } else {
    try {
      const params = aztecCmcId
        ? new URLSearchParams({ id: `1027,${aztecCmcId}`, convert: "USD" })
        : new URLSearchParams({ symbol: `ETH,${aztecSymbol}`, convert: "USD" });
      const d = await fetchJSON(`${CMC_BASE}/v1/cryptocurrency/quotes/latest?${params}`, {
        headers: { "X-CMC_PRO_API_KEY": cmcKey, Accept: "application/json" },
      });
      if (d.status?.error_code !== 0) {
        out.errors.push(`cmc quotes: ${d.status?.error_message || "unknown"}`);
      }
      // Response keyed by id or by symbol. For symbol lookup, a key may resolve to an array when ambiguous.
      const data = d.data || {};
      const resolve = (key: string) => {
        const entry = data[key];
        if (!entry) return null;
        const node = Array.isArray(entry) ? entry[0] : entry;
        const price = node?.quote?.USD?.price;
        return typeof price === "number" && Number.isFinite(price) ? price : null;
      };
      if (aztecCmcId) {
        out.ethPriceUSD = resolve("1027");
        out.aztecPriceUSD = resolve(aztecCmcId);
      } else {
        out.ethPriceUSD = resolve("ETH");
        out.aztecPriceUSD = resolve(aztecSymbol);
      }
      if (!out.aztecPriceUSD) {
        out.notes.push(`AZTEC price not returned by CMC. Set AZTEC_CMC_ID to the CoinMarketCap numeric ID to disambiguate (symbol "${aztecSymbol}" may not be unique or may not be listed).`);
      }
    } catch (e) {
      out.errors.push(`cmc quotes fetch failed: ${(e as Error).message}`);
    }
  }

  // Etherscan V2 responses have a "result" field that can be a string/object on success OR an error
  // string (e.g. "Invalid API Key", "Max calls per sec exceeded") when status === "0". We surface
  // the full message so auth/rate issues are diagnosable.
  const esError = (d: { status?: string; message?: string; result?: unknown }) => {
    const msg = typeof d.message === "string" && d.message !== "NOTOK" ? d.message : "";
    const res = typeof d.result === "string" ? d.result : "";
    return [msg, res].filter(Boolean).join(" - ") || "unknown";
  };

  // ---- Gas (Etherscan V2) ----
  if (!etherscanKey) {
    out.errors.push("ETHERSCAN_API_KEY env var is not set — skipping gas + blob lookup");
  } else {
    // Current gas price (free tier).
    try {
      const d = await fetchJSON(`${ETHERSCAN_V2}?chainid=${CHAIN_ID}&module=gastracker&action=gasoracle&apikey=${etherscanKey}`);
      if (d.status === "1") {
        out.gasPriceGwei.current = parseFloat(d.result.ProposeGasPrice);
      } else {
        out.errors.push(`gasoracle: ${esError(d)}`);
      }
    } catch (e) {
      out.errors.push(`gasoracle fetch failed: ${(e as Error).message}`);
    }

    // 30-day rolling average of daily gas prices (Pro endpoint: Standard plan and above).
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const fmt = (dt: Date) => dt.toISOString().slice(0, 10); // YYYY-MM-DD
      const d = await fetchJSON(
        `${ETHERSCAN_V2}?chainid=${CHAIN_ID}&module=stats&action=dailyavggasprice&startdate=${fmt(start)}&enddate=${fmt(end)}&sort=desc&apikey=${etherscanKey}`
      );
      if (d.status === "1" && Array.isArray(d.result) && d.result.length > 0) {
        const values = d.result.map((row: { avgGasPrice_Wei: string }) => parseFloat(row.avgGasPrice_Wei) / 1e9);
        const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
        out.gasPriceGwei.avg30d = avg;
        out.notes.push(`30-day avg gas = mean of ${values.length} daily averages from ${fmt(start)} to ${fmt(end)}`);
      } else {
        out.errors.push(`dailyavggasprice: ${esError(d)} (likely requires Etherscan Standard plan or above)`);
      }
    } catch (e) {
      out.errors.push(`dailyavggasprice fetch failed: ${(e as Error).message}`);
    }

    // Blob base fee via Etherscan's proxy module (uses Etherscan's node, supports eth_blobBaseFee).
    try {
      const d = await fetchJSON(`${ETHERSCAN_V2}?chainid=${CHAIN_ID}&module=proxy&action=eth_blobBaseFee&apikey=${etherscanKey}`);
      if (d.result && typeof d.result === "string" && d.result.startsWith("0x")) {
        out.blobGasPriceGwei = Number(BigInt(d.result)) / 1e9;
        out.notes.push("Blob base fee is current (not 30-day avg - no free historical endpoint)");
      } else {
        // Fallback to a public Ethereum RPC if Etherscan proxy doesn't return a result.
        const rpc = await fetchJSON(FALLBACK_ETH_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blobBaseFee", params: [], id: 1 }),
        });
        if (rpc.result) {
          out.blobGasPriceGwei = Number(BigInt(rpc.result)) / 1e9;
          out.notes.push(`Blob base fee via fallback RPC ${FALLBACK_ETH_RPC} (Etherscan proxy didn't return a result)`);
        } else {
          out.errors.push(`blob base fee: Etherscan proxy returned nothing, fallback RPC error: ${rpc.error?.message || "unknown"}`);
        }
      }
    } catch (e) {
      out.errors.push(`blob base fee fetch failed: ${(e as Error).message}`);
    }
  }

  return NextResponse.json(out, { status: 200 });
}
