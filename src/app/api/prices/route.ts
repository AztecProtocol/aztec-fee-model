import { NextResponse } from "next/server";

// Etherscan V2 unified endpoint (V1 paths are being deprecated; V2 requires chainid).
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "1"; // Ethereum mainnet.

// CoinMarketCap Pro API (free "Basic" tier works for the quotes/latest endpoint).
const CMC_BASE = "https://pro-api.coinmarketcap.com";

// Fallback Ethereum JSON-RPC. publicnode supports batched JSON-RPC and has more lenient rate
// limits than llamarpc; override via ETH_RPC_URL for an authenticated provider.
const FALLBACK_ETH_RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";

type ProtocolState = {
  // Governance constants (only change via passed proposals; effectively static).
  manaTarget: number | null;
  manaLimit: number | null;
  provingCostPerManaWei: number | null; // wei of ETH per mana
  checkpointRewardAZTEC: number | null; // whole AZTEC tokens per checkpoint
  sequencerBps: number | null; // 0-10000
  slotDurationSec: number | null;
  epochDurationSlots: number | null;
  proofSubmissionEpochs: number | null;
  // Slow-moving oracles (proposer-updated, lagged).
  ethPerFeeAssetE12: number | null; // ETH/AZTEC × 1e12, max ±1% per L2 slot
  l1BaseFeeWei: number | null; // L1 base fee from on-chain oracle
  l1BlobFeeWei: number | null; // L1 blob base fee from on-chain oracle
  // Derived (recomputed on-chain whenever any input changes).
  manaMinFeeWeiETH: number | null; // wei ETH per mana (current min fee)
  manaMinFeeWeiFeeAsset: number | null; // wei AZTEC per mana
};

type PricesResponse = {
  timestamp: string;
  ethPriceUSD: number | null;
  aztecPriceUSD: number | null;
  gasPriceGwei: { current: number | null; avg30d: number | null };
  blobGasPriceGwei: number | null;
  protocolState: ProtocolState;
  notes: string[];
  errors: string[];
};

// Aztec Alpha mainnet rollup contract address.
const ROLLUP_ADDRESS = process.env.AZTEC_ROLLUP_ADDRESS || "0xae2001f7e21d5ecabf6234e9fdd1e76f50f74962";

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

// JSON-RPC batch call: one HTTP request, many eth_calls. Avoids per-second rate limits on
// public RPCs that count requests rather than total work.
async function ethCallBatch(rpc: string, to: string, datas: string[]): Promise<(string | null)[]> {
  const payload = datas.map((data, i) => ({
    jsonrpc: "2.0", method: "eth_call",
    params: [{ to, data }, "latest"],
    id: i,
  }));
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) {
    // Some RPCs reject batches; fall back to sequential.
    return Promise.all(datas.map((d) => ethCall(rpc, to, d).catch(() => null)));
  }
  // Response order may differ from request order; sort by id.
  const byId = new Map<number, { result?: string; error?: { message: string } }>();
  for (const entry of j) byId.set(entry.id, entry);
  return datas.map((_, i) => {
    const entry = byId.get(i);
    if (!entry) return null;
    if (entry.error) return null;
    return entry.result ?? null;
  });
}

// Decode a uint256 from a 32-byte hex chunk.
function hexToBigInt(hex: string): bigint { return BigInt(hex); }

// Function selectors (4-byte) for Rollup.sol getters. Verified via `cast sig`.
const SELECTORS = {
  getManaTarget: "0x3f47ad06",
  getManaLimit: "0x29c24030",
  getProvingCostPerManaInEth: "0x4eb4a4d6",
  getEthPerFeeAsset: "0x375fae1f",
  getCheckpointReward: "0x86a0d763",
  getSlotDuration: "0xc4014c12",
  getEpochDuration: "0x5d3ea8f1",
  getProofSubmissionEpochs: "0x25b22366",
  getL1FeesAt: "0x5f82401f", // (uint256 timestamp)
  getManaMinFeeAt: "0x766d01b4", // (uint256 timestamp, bool inFeeAsset)
  getRewardConfig: "0xec147806",
} as const;

function pad32(n: bigint | number | boolean): string {
  let v: bigint;
  if (typeof n === "boolean") v = n ? BigInt(1) : BigInt(0);
  else if (typeof n === "number") v = BigInt(n);
  else v = n;
  return v.toString(16).padStart(64, "0");
}

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
    protocolState: {
      manaTarget: null, manaLimit: null, provingCostPerManaWei: null,
      checkpointRewardAZTEC: null, sequencerBps: null,
      slotDurationSec: null, epochDurationSlots: null, proofSubmissionEpochs: null,
      ethPerFeeAssetE12: null, l1BaseFeeWei: null, l1BlobFeeWei: null,
      manaMinFeeWeiETH: null, manaMinFeeWeiFeeAsset: null,
    },
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

  // ---- On-chain protocol state (Aztec Rollup) ----
  // Pulls live values from the Rollup contract via raw eth_call. These are the authoritative
  // values the protocol uses for fee/reward calculations. Most are slow-moving:
  //  - Governance constants (manaTarget, sequencerBps, etc.) only change on passed proposals
  //  - L1 fee oracle values lag the actual market (proposer-updated, ~5 min cadence)
  //  - ethPerFeeAsset can move ±1%/slot, so drifts toward market over hours
  // Cache via the client-side localStorage layer (1h) is appropriate.
  try {
    const rpc = FALLBACK_ETH_RPC;
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const nowHex = "0x" + pad32(BigInt(nowTimestamp));
    // Single batched JSON-RPC request: 11 eth_calls in one HTTP POST. Public RPCs typically
    // rate-limit by request count, so batching avoids 429s that sequential calls hit.
    const calldatas = [
      SELECTORS.getManaTarget,
      SELECTORS.getManaLimit,
      SELECTORS.getProvingCostPerManaInEth,
      SELECTORS.getEthPerFeeAsset,
      SELECTORS.getCheckpointReward,
      SELECTORS.getSlotDuration,
      SELECTORS.getEpochDuration,
      SELECTORS.getProofSubmissionEpochs,
      SELECTORS.getL1FeesAt + nowHex.slice(2),
      SELECTORS.getManaMinFeeAt + nowHex.slice(2) + pad32(false),
      SELECTORS.getManaMinFeeAt + nowHex.slice(2) + pad32(true),
    ];
    let results = await ethCallBatch(rpc, ROLLUP_ADDRESS, calldatas);
    // Retry any nulls once with a brief delay (transient `header not found` upstream issues).
    if (results.some((r) => r === null)) {
      await new Promise((res) => setTimeout(res, 500));
      const retryDatas = calldatas.filter((_, i) => results[i] === null);
      const retryResults = await ethCallBatch(rpc, ROLLUP_ADDRESS, retryDatas);
      let retryIdx = 0;
      results = results.map((r) => r === null ? (retryResults[retryIdx++] ?? null) : r);
    }
    const [mt, ml, prv, eth4fa, ckptR, slotD, epochD, proofSE, l1Fees, manaMinETH, manaMinFA] = results;
    if (results.includes(null)) {
      const failed = calldatas.filter((_, i) => results[i] === null).map((d) => d.slice(0, 10));
      out.errors.push(`some rollup eth_calls failed after retry: ${failed.join(", ")}`);
    }
    const ps = out.protocolState;
    if (mt) ps.manaTarget = Number(hexToBigInt(mt));
    if (ml) ps.manaLimit = Number(hexToBigInt(ml));
    if (prv) ps.provingCostPerManaWei = Number(hexToBigInt(prv));
    if (eth4fa) ps.ethPerFeeAssetE12 = Number(hexToBigInt(eth4fa));
    if (ckptR) ps.checkpointRewardAZTEC = Number(hexToBigInt(ckptR) / BigInt(1e15)) / 1e3; // wei → AZTEC, keep precision
    if (slotD) ps.slotDurationSec = Number(hexToBigInt(slotD));
    if (epochD) ps.epochDurationSlots = Number(hexToBigInt(epochD));
    if (proofSE) ps.proofSubmissionEpochs = Number(hexToBigInt(proofSE));
    if (l1Fees && l1Fees.length >= 2 + 64 * 2) {
      ps.l1BaseFeeWei = Number(hexToBigInt("0x" + l1Fees.slice(2, 2 + 64)));
      ps.l1BlobFeeWei = Number(hexToBigInt("0x" + l1Fees.slice(2 + 64, 2 + 128)));
    }
    if (manaMinETH) ps.manaMinFeeWeiETH = Number(hexToBigInt(manaMinETH));
    if (manaMinFA) ps.manaMinFeeWeiFeeAsset = Number(hexToBigInt(manaMinFA));
    out.notes.push(`Rollup state read from ${ROLLUP_ADDRESS} via ${rpc}`);
  } catch (e) {
    out.errors.push(`rollup state fetch failed: ${(e as Error).message}`);
  }

  return NextResponse.json(out, { status: 200 });
}
