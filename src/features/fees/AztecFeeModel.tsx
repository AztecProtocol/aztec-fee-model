"use client";
import React, { useMemo, useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Info } from "lucide-react";
import { ResponsiveContainer, Tooltip, ComposedChart, Bar, XAxis, YAxis, Cell, LabelList } from "recharts";
import { usePrices } from "./usePrices";

const fmtUSD = (n: number, d = 2) => {
  if (!isFinite(n)) return "–";
  const abs = Math.abs(n);
  // Small fractional numbers: use significant digits so we don't round tiny values to $0.
  if (abs !== 0 && abs < 1) {
    return `$${n.toLocaleString(undefined, { maximumSignificantDigits: Math.max(4, d + 2) })}`;
  }
  // >=1 or zero: thousand separators + up to d fractional digits (no forced trailing zeros).
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: d })}`;
};
const fmtUSDSig4 = (n: number) => (isFinite(n) ? n.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : "–");
const fmtNum = (n: number, d = 0) => (isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "–");

// Terminology (post-Alpha):
//   Slot       = L1 publishing unit; one checkpoint published per slot. (72s in Alpha)
//   Checkpoint = the slot's payload published to L1.
//   Block      = sub-unit within a slot; Alpha lets sequencers build multiple blocks per slot.
//   Epoch      = N slots; committee selection and proof window are per epoch.
// Internal variable names still use `blockTime` / `blocksPerEpoch` for the slot duration /
// slots-per-epoch (historical naming); user-facing labels use Slot terminology.
interface NetworkParams { tps: number; blockTime: number; blocksPerEpoch: number; blocksPerSlot: number; maxTxPerCheckpoint: number; manaPerTx: number; bytesPerTxDA: number; bytesPerBlob: number; maxBlobsPerEthBlock: number; targetBlobsPerEthBlock: number; }
interface CostParams { ethPrice: number; l1GasPriceGwei: number; l1ExecGasPerBlock: number; blobGasPriceGwei: number; proofVerifyGasPerEpoch: number; proverComputeUSDPerTx: number; }
interface CongestionParams { minMultiplier: number; manaTarget: number; manaLimit: number; tipPctOfBase: number; proverShareOfUnburnedBase: number; blobsPerBlockPolicy: number; }
interface GovParams { maxSupplyTokens: number; circulatingPct: number; stakeRatePct: number; issuanceRateOnMaxPct: number; tokenPriceUSD: number; operatorIssuanceSeqSharePct: number; operatorIssuanceProvSharePct: number; }
interface SequencerParams { targetCommitteeSize: number; minSequencerStake: number; stakePerSequencer: number; proofSubmissionEpochs: number; }

const DEFAULT: { net: NetworkParams; cost: CostParams; cong: CongestionParams; gov: GovParams; seq: SequencerParams } = {
  // maxBlobsPerEthBlock = 21, targetBlobsPerEthBlock = 14 reflect post-Fusaka mainnet after
  // BPO2 (activated 2026-01-07). Fusaka introduced PeerDAS and made target/max independently
  // tunable via Blob Parameter Only forks; see EIP-7892.
  net: { tps: 1, blockTime: 72, blocksPerEpoch: 32, blocksPerSlot: 6, maxTxPerCheckpoint: 72, manaPerTx: 50_000, bytesPerTxDA: 1200, bytesPerBlob: 131_072, maxBlobsPerEthBlock: 21, targetBlobsPerEthBlock: 14 },
  // l1ExecGasPerBlock: 325K from gas_benchmark.md. It already includes setupEpoch amortization
  // (setupEpoch is called from propose and is only expensive at epoch boundaries; rest is a no-op).
  // Extra gas for signal/vote casting (e.g. proposeAndVote via Multicall3) is not modeled here —
  // adds ~50K per proposal only on slots where the sequencer casts a governance vote.
  // proofVerifyGasPerEpoch: 3.5M on Alpha (unoptimized verifier). gas_benchmark.md shows ~900K
  // but that measurement excludes the actual SNARK verification; real on-chain cost is ~3.5M.
  cost: { ethPrice: 2200, l1GasPriceGwei: 1, l1ExecGasPerBlock: 325_000, blobGasPriceGwei: 1, proofVerifyGasPerEpoch: 3_500_000, proverComputeUSDPerTx: 0.003 },
  cong: { minMultiplier: 1.1, manaTarget: 75_000_000, manaLimit: 150_000_000, tipPctOfBase: 10, proverShareOfUnburnedBase: 0.3, blobsPerBlockPolicy: 9 },
  gov: { maxSupplyTokens: 10_350_000_000, circulatingPct: 28.60, stakeRatePct: 24.87, issuanceRateOnMaxPct: 2.12, tokenPriceUSD: 0.02, operatorIssuanceSeqSharePct: 70, operatorIssuanceProvSharePct: 30 },
  seq: { targetCommitteeSize: 48, minSequencerStake: 190_000, stakePerSequencer: 200_000, proofSubmissionEpochs: 1 }
};

type StageName = "Ignition"|"Alpha"|"Beta";
const PRESETS: Record<StageName, { net: NetworkParams; cost: CostParams; cong: CongestionParams; gov: GovParams; seq: SequencerParams }> = {
  Alpha: { ...DEFAULT },
  Ignition: {
    net: { ...DEFAULT.net, tps: 0, blockTime: 72, blocksPerEpoch: 32, blocksPerSlot: 1, maxTxPerCheckpoint: 72, maxBlobsPerEthBlock: 6, targetBlobsPerEthBlock: 3 },
    cost: { ...DEFAULT.cost },
    cong: { ...DEFAULT.cong, minMultiplier: 1, manaTarget: 5_000_000, manaLimit: 10_000_000 },
    gov: { ...DEFAULT.gov, circulatingPct: 22.5, stakeRatePct: 80, issuanceRateOnMaxPct: 2, operatorIssuanceSeqSharePct: 92.5, operatorIssuanceProvSharePct: 7.5 },
    seq: { ...DEFAULT.seq, targetCommitteeSize: 24 }
  },
  Beta: {
    net: { ...DEFAULT.net, tps: 120, blockTime: 6, blocksPerEpoch: 64, blocksPerSlot: 1, maxTxPerCheckpoint: 10_000, maxBlobsPerEthBlock: 21, targetBlobsPerEthBlock: 14 },
    cost: { ...DEFAULT.cost },
    cong: { ...DEFAULT.cong, manaTarget: 32_500_000, blobsPerBlockPolicy: 10 },
    gov: { ...DEFAULT.gov, circulatingPct: 90, operatorIssuanceSeqSharePct: 92.5, operatorIssuanceProvSharePct: 7.5 },
    seq: { ...DEFAULT.seq }
  }
};

function useModel(net: NetworkParams, cost: CostParams, cong: CongestionParams, gov: GovParams, seq: SequencerParams, proverPremiumPct: number) {
  return useMemo(() => {
    const txPerBlockDemand = net.tps * net.blockTime;
    const manaLimit = cong.manaTarget * 2;
    const txPerBlockCapacity_mana = Math.floor(manaLimit / Math.max(1, net.manaPerTx));
    const ETH_BLOCK_TIME = 12;

    const gasPriceETH = cost.l1GasPriceGwei * 1e-9;
    const blobGasPriceETH = cost.blobGasPriceGwei * 1e-9;
    const blobGasPerBlob = 2 ** 17;
    const blobFeePerBlobETH = blobGasPerBlob * blobGasPriceETH;
    const blobFeePerBlobUSD = blobFeePerBlobETH * cost.ethPrice;

    const ethBlobBudgetPerL2Block_float = net.maxBlobsPerEthBlock * (net.blockTime / ETH_BLOCK_TIME);
    const ethBlobBudgetPerL2Block = Math.max(0, Math.floor(ethBlobBudgetPerL2Block_float));
    const ethBlobTargetPerL2Block_float = net.targetBlobsPerEthBlock * (net.blockTime / ETH_BLOCK_TIME);
    const ethBlobTargetPerL2Block = Math.max(0, Math.floor(ethBlobTargetPerL2Block_float));
    const policyBlobCap = Math.max(1, Math.floor(cong.blobsPerBlockPolicy));

    const proposalBlobsETH = Math.min(1, ethBlobBudgetPerL2Block);
    const dataBlobCapETH = Math.max(0, ethBlobBudgetPerL2Block - proposalBlobsETH);

    const proposalBlobsPOL = Math.min(1, policyBlobCap);
    const dataBlobCapPOL = Math.max(0, policyBlobCap - proposalBlobsPOL);

    const dataBytesPerBlock = Math.max(0, Math.floor(net.bytesPerTxDA * txPerBlockDemand));
    const dataBlobsNeeded = Math.ceil(dataBytesPerBlock / Math.max(1, net.bytesPerBlob));
    const dataBlobsUsed = Math.min(dataBlobsNeeded, dataBlobCapETH);
    const blobsUsed = proposalBlobsETH + dataBlobsUsed;

    const maxTxPerBlock_byBlob = Math.floor((dataBlobCapETH * net.bytesPerBlob) / Math.max(1, net.bytesPerTxDA));
    const txPerBlockCapacity = Math.min(txPerBlockCapacity_mana, maxTxPerBlock_byBlob, Math.max(0, net.maxTxPerCheckpoint));
    const txPerBlock = Math.max(0, Math.min(txPerBlockDemand, txPerBlockCapacity));

    const epochTimeSec = net.blocksPerEpoch * net.blockTime;
    const blobsPerEpochUsed = blobsUsed * net.blocksPerEpoch;

    const verifyETHPerEpoch = cost.proofVerifyGasPerEpoch * gasPriceETH;
    const verifyETHPerBlock = verifyETHPerEpoch / Math.max(1, net.blocksPerEpoch);
    const proverOnchainUSDPerBlock_FIXED = verifyETHPerBlock * cost.ethPrice;

    // setupEpoch is already included in the benchmark for propose() - see l1ExecGasPerBlock comment.
    const seqExecETHPerBlock_GAS_FIXED = cost.l1ExecGasPerBlock * gasPriceETH;
    const proposalBlobETHPerBlock_FIXED = proposalBlobsETH * blobFeePerBlobETH;
    const seqExecUSDPerBlock_GAS_FIXED = seqExecETHPerBlock_GAS_FIXED * cost.ethPrice;
    const proposalBlobUSDPerBlock_FIXED = proposalBlobETHPerBlock_FIXED * cost.ethPrice;

    const seqBlobETHPerBlock_VARIABLE = dataBlobsUsed * blobFeePerBlobETH;
    const seqBlobUSDPerBlock_VARIABLE = seqBlobETHPerBlock_VARIABLE * cost.ethPrice;

    const billedDataBlobsPerBlock = dataBlobCapPOL;
    const seqBlobUSDPerBlock_BILLED = billedDataBlobsPerBlock * blobFeePerBlobUSD;

    const l1USDPerBlock_Sequencer_ACTUAL = seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED + seqBlobUSDPerBlock_VARIABLE;
    const l1USDPerBlock_Sequencer_BILLED = seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED + seqBlobUSDPerBlock_BILLED;
    const l1USDPerBlock_Prover_ACTUAL = proverOnchainUSDPerBlock_FIXED;
    const proverSubsidyUSDPerBlock_FIXED = l1USDPerBlock_Prover_ACTUAL * 2;

    const seqCostPerManaUSD_ACTUAL = l1USDPerBlock_Sequencer_ACTUAL / Math.max(1e-9, cong.manaTarget);
    const seqCostPerManaUSD_BILLED = l1USDPerBlock_Sequencer_BILLED / Math.max(1e-9, cong.manaTarget);

    const proverVerifyPerManaUSD = l1USDPerBlock_Prover_ACTUAL / Math.max(1e-9, cong.manaTarget);
    const proverComputeUSD_tx_ACTUAL = cost.proverComputeUSDPerTx;
    const proverComputeUSD_tx_BILLED = cost.proverComputeUSDPerTx * (1 + proverPremiumPct / 100);
    const proverComputePerManaUSD_ACTUAL = proverComputeUSD_tx_ACTUAL / Math.max(1, net.manaPerTx);
    const proverComputePerManaUSD_BILLED = proverComputeUSD_tx_BILLED / Math.max(1, net.manaPerTx);

    const baseComponentPerManaUSD_ACTUAL = seqCostPerManaUSD_ACTUAL + proverVerifyPerManaUSD + proverComputePerManaUSD_ACTUAL;
    const baseComponentPerManaUSD_BILLED = seqCostPerManaUSD_BILLED + proverVerifyPerManaUSD + proverComputePerManaUSD_BILLED;

    const blockManaUsed = txPerBlock * net.manaPerTx;
    const excessMana = Math.max(0, blockManaUsed - cong.manaTarget);
    const feeUpdateFraction = cong.manaTarget / 0.117;
    const congestionMultiplier = cong.minMultiplier * Math.exp(excessMana / Math.max(1e-9, feeUpdateFraction));

    const baseFeePerManaUSD = baseComponentPerManaUSD_BILLED * congestionMultiplier;
    const baseFeePerManaETH = baseFeePerManaUSD / Math.max(1e-9, cost.ethPrice);
    const baseFeePerManaGwei = baseFeePerManaETH / 1e-9;
    const manaPerGwei = baseFeePerManaGwei > 0 ? 1 / baseFeePerManaGwei : 0;

    const tipPerManaUSD = baseFeePerManaUSD * (cong.tipPctOfBase / 100);
    const burnPerManaUSD = Math.max(0, baseComponentPerManaUSD_BILLED * (congestionMultiplier - 1));

    const unburnedPerManaUSD = baseComponentPerManaUSD_BILLED;
    const toProverPerManaUSD = unburnedPerManaUSD * cong.proverShareOfUnburnedBase;
    const toSequencerPerManaUSD = unburnedPerManaUSD - toProverPerManaUSD;

    const feeBaseUSD_tx = baseFeePerManaUSD * net.manaPerTx;
    const feeTipUSD_tx = tipPerManaUSD * net.manaPerTx;
    const burnUSD_tx = burnPerManaUSD * net.manaPerTx;

    const l1USDPerTx_DA = seqBlobUSDPerBlock_VARIABLE / Math.max(1, txPerBlock);
    const l1USDPerTx_Verify = proverOnchainUSDPerBlock_FIXED / Math.max(1, txPerBlock);
    const l1USDPerTx_Total = l1USDPerTx_DA + l1USDPerTx_Verify;

    const sequencerETHCostPerTx = (seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED)/Math.max(1,txPerBlock) + l1USDPerTx_DA;
    const proverETHCostPerTx = l1USDPerTx_Verify;

    const proverComputeUSD_tx = proverComputeUSD_tx_ACTUAL;

    const seqRevenueUSD_tx = toSequencerPerManaUSD * net.manaPerTx + feeTipUSD_tx;
    const provRevenueUSD_tx = toProverPerManaUSD * net.manaPerTx;

    const seqFixedUSDPerBlock = seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED;
    const seqFixedUSDPerTx = seqFixedUSDPerBlock / Math.max(1, txPerBlock);

    const feesRetained_tx = feeBaseUSD_tx + feeTipUSD_tx - burnUSD_tx;
    const fundSeq = Math.min(sequencerETHCostPerTx, Math.max(0, feesRetained_tx));
    const fundProv = Math.min(proverETHCostPerTx, Math.max(0, feesRetained_tx - fundSeq));
    const passThroughFeesToETH_tx = fundSeq + fundProv;

    // seqNetUSD_tx is sequencer revenue minus protocol-level L1 costs only.
    // Infrastructure / operational overhead (servers, monitoring, ops) is deliberately excluded
    // from the dashboard. Operators should model it themselves.
    const seqNetUSD_tx = seqRevenueUSD_tx - (l1USDPerTx_DA + seqFixedUSDPerTx);
    const provNetUSD_tx = provRevenueUSD_tx - (l1USDPerTx_Verify + proverComputeUSD_tx);

    const totalUserFeeUSD_tx = feeBaseUSD_tx + feeTipUSD_tx;
    const coveredByBurnPct = l1USDPerTx_Total > 0 ? Math.min(100, (burnUSD_tx / l1USDPerTx_Total) * 100) : (burnUSD_tx > 0 ? 100 : 0);

    const blocksPerDay = 86_400 / net.blockTime;
    const txPerDay = txPerBlock * blocksPerDay;

    const circTokens = gov.maxSupplyTokens * (gov.circulatingPct / 100);
    const stakedTokens = circTokens * (gov.stakeRatePct / 100);
    const issuanceTokensPerYear = gov.maxSupplyTokens * (gov.issuanceRateOnMaxPct / 100);
    const stakerAPYPerToken = stakedTokens > 0 ? issuanceTokensPerYear / stakedTokens : 0;
    const _stakerAPYPct = stakerAPYPerToken * 100;
    const blocksPerYear = 365 * 24 * 3600 / Math.max(1e-9, net.blockTime);
    const issuanceTokensPerBlock = issuanceTokensPerYear / blocksPerYear;
    const issuanceUSDPerBlock = issuanceTokensPerBlock * gov.tokenPriceUSD;
    // Issuance splits: Alpha is 70% sequencers + 20% provers + 10% retained/other (burn/treasury).
    // Shares are configured independently; remainder = 100% − seq − prov goes to "other".
    const issuanceToSequencersUSDPerBlock = issuanceUSDPerBlock * (gov.operatorIssuanceSeqSharePct / 100);
    const issuanceToProversUSDPerBlock = issuanceUSDPerBlock * (gov.operatorIssuanceProvSharePct / 100);
    const issuanceToOperatorsUSDPerBlock = issuanceToSequencersUSDPerBlock + issuanceToProversUSDPerBlock;
    const issuanceToOtherUSDPerBlock = Math.max(0, issuanceUSDPerBlock - issuanceToOperatorsUSDPerBlock);
    const issuanceToStakersUSDPerBlock = 0;
    const burnUSDPerBlock = burnPerManaUSD * blockManaUsed;
    const netIssuanceAfterBurnUSDPerBlock = issuanceUSDPerBlock - burnUSDPerBlock;
    const paidToETHUSDPerBlock = (seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED + seqBlobUSDPerBlock_VARIABLE) + proverOnchainUSDPerBlock_FIXED;
    const nonETHSubsidyUSDPerBlock = proverSubsidyUSDPerBlock_FIXED;
    const pureInflationUSDPerBlock = Math.max(0, issuanceToOperatorsUSDPerBlock - (paidToETHUSDPerBlock + nonETHSubsidyUSDPerBlock));
    const stakedUSD = stakedTokens * gov.tokenPriceUSD;
    const stakerRealAPYPct = stakedUSD > 0 ? (((issuanceToStakersUSDPerBlock - Math.max(0, netIssuanceAfterBurnUSDPerBlock)) * blocksPerYear) / stakedUSD) * 100 : 0;

    const tpsLimitByMana = txPerBlockCapacity_mana / Math.max(1e-9, net.blockTime);
    const tpsLimitByBlobs = Math.floor((dataBlobCapETH * net.bytesPerBlob) / Math.max(1, net.bytesPerTxDA)) / Math.max(1e-9, net.blockTime);

    const gasPriceGwei = cost.l1GasPriceGwei;
    const blobGasPriceGwei = cost.blobGasPriceGwei;

    // Per-sequencer economics.
    // Assumes uniform stake, uniform proposer rotation: each sequencer proposes 1/N slots.
    const numActiveSequencers = Math.max(1, Math.floor(stakedTokens / Math.max(1, seq.stakePerSequencer)));
    const slotsPerSequencerPerYear = blocksPerYear / numActiveSequencers;

    const seqFeeRevenueUSDPerBlock = (toSequencerPerManaUSD * net.manaPerTx + feeTipUSD_tx) * txPerBlock;
    const sequencer_fee_earnings_USD_per_year = seqFeeRevenueUSDPerBlock * slotsPerSequencerPerYear;
    const sequencer_fee_earnings_AZTEC_per_year = gov.tokenPriceUSD > 0 ? sequencer_fee_earnings_USD_per_year / gov.tokenPriceUSD : 0;
    const sequencer_issuance_AZTEC_per_year = (issuanceTokensPerYear * (gov.operatorIssuanceSeqSharePct / 100)) / numActiveSequencers;
    const sequencer_issuance_USD_per_year = sequencer_issuance_AZTEC_per_year * gov.tokenPriceUSD;
    const sequencer_total_earnings_USD_per_year = sequencer_fee_earnings_USD_per_year + sequencer_issuance_USD_per_year;
    const sequencer_total_earnings_AZTEC_per_year = sequencer_issuance_AZTEC_per_year + sequencer_fee_earnings_AZTEC_per_year;

    const sequencer_L1_costs_USD_per_year = l1USDPerBlock_Sequencer_ACTUAL * slotsPerSequencerPerYear;
    const sequencer_L1_costs_ETH_per_year = sequencer_L1_costs_USD_per_year / Math.max(1e-9, cost.ethPrice);
    const sequencer_total_costs_USD_per_year = sequencer_L1_costs_USD_per_year;

    const sequencer_net_USD_per_year = sequencer_total_earnings_USD_per_year - sequencer_total_costs_USD_per_year;
    const sequencer_stake_USD = seq.stakePerSequencer * gov.tokenPriceUSD;
    const sequencer_APY_pct = sequencer_stake_USD > 0 ? (sequencer_net_USD_per_year / sequencer_stake_USD) * 100 : 0;
    const sequencer_issuance_APY_pct = sequencer_stake_USD > 0 ? (sequencer_issuance_USD_per_year / sequencer_stake_USD) * 100 : 0;

    return { txPerBlockDemand, txPerBlockCapacity_mana, txPerBlockCapacity, txPerBlock, epochTimeSec, blocksPerDay, txPerDay, ETH_BLOCK_TIME,
      ethBlobBudgetPerL2Block_float, ethBlobBudgetPerL2Block, ethBlobTargetPerL2Block,
      policyBlobCap,
      proposalBlobsPerBlock: proposalBlobsETH,
      dataBlobCapacityPerL2Block: dataBlobCapETH,
      dataBytesPerBlock, dataBlobsNeeded, dataBlobsUsed, blobsUsed, blobsPerEpochUsed, blobFeePerBlobUSD, gasPriceETH, gasPriceGwei, blobGasPriceGwei,
      seqExecUSDPerBlock_GAS_FIXED, proposalBlobUSDPerBlock_FIXED, seqBlobUSDPerBlock_VARIABLE, seqBlobUSDPerBlock_BILLED,
      proverOnchainUSDPerBlock_FIXED, proverSubsidyUSDPerBlock_FIXED,
      seqCostPerManaUSD: seqCostPerManaUSD_ACTUAL, seqCostPerManaUSD_BILLED, proverVerifyPerManaUSD, proverComputePerManaUSD: proverComputePerManaUSD_ACTUAL, proverComputePerManaUSD_BILLED,
      baseComponentPerManaUSD: baseComponentPerManaUSD_ACTUAL, baseComponentPerManaUSD_BILLED,
      congestionMultiplier, baseFeePerManaUSD, baseFeePerManaGwei, manaPerGwei, tipPerManaUSD, burnPerManaUSD,
      feeBaseUSD_tx, feeTipUSD_tx, burnUSD_tx, l1USDPerTx_DA, l1USDPerTx_Verify, l1USDPerTx_Total,
      sequencerETHCostPerTx, proverETHCostPerTx,
      seqRevenueUSD_tx, provRevenueUSD_tx, seqFixedUSDPerTx,
      seqNetUSD_tx, provNetUSD_tx, totalUserFeeUSD_tx,
      passThroughFeesToETH_tx,
      coveredByBurnPct,
      excessMana: Math.max(0, blockManaUsed - cong.manaTarget), blockManaUsed,
      maxTxPerBlock_byBlob, tpsLimitByMana, tpsLimitByBlobs,
      issuanceTokensPerYear, issuanceTokensPerBlock, issuanceUSDPerBlock, issuanceToOperatorsUSDPerBlock, issuanceToStakersUSDPerBlock, issuanceToSequencersUSDPerBlock, issuanceToProversUSDPerBlock, issuanceToOtherUSDPerBlock, burnUSDPerBlock, netIssuanceAfterBurnUSDPerBlock,
      circTokens, stakedTokens, _stakerAPYPct, pureInflationUSDPerBlock, stakerRealAPYPct,
      toSequencerPerManaUSD, toProverPerManaUSD,
      numActiveSequencers, slotsPerSequencerPerYear,
      sequencer_fee_earnings_USD_per_year, sequencer_fee_earnings_AZTEC_per_year, sequencer_issuance_AZTEC_per_year, sequencer_issuance_USD_per_year, sequencer_total_earnings_USD_per_year, sequencer_total_earnings_AZTEC_per_year,
      sequencer_L1_costs_ETH_per_year, sequencer_L1_costs_USD_per_year, sequencer_total_costs_USD_per_year,
      sequencer_net_USD_per_year, sequencer_stake_USD, sequencer_APY_pct, sequencer_issuance_APY_pct };
  }, [net, cost, cong, gov, seq, proverPremiumPct]);
}

function formatForInput(n: number): string {
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString(undefined, { maximumFractionDigits: 10, useGrouping: true });
}

function NumberSlider({ label, min, max, step = 1, value, onChange, suffix, prefix, disabled = false }: { label: string; min: number; max: number; step?: number; value: number; onChange: (n: number) => void; suffix?: string; prefix?: string; disabled?: boolean; }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string>(formatForInput(value));
  // Sync the draft with the incoming value when not editing (e.g. slider drag, stage change).
  React.useEffect(() => {
    if (!editing) setDraft(formatForInput(value));
  }, [value, editing]);
  return (
    <div className={`space-y-2 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm text-slate-500">{label}</Label>
        <div className="flex items-center gap-1 shrink-0">
          {prefix && <span className="text-sm text-slate-500">{prefix}</span>}
          <input
            type="text"
            inputMode="decimal"
            disabled={!!disabled}
            value={draft}
            onFocus={() => setEditing(true)}
            onChange={(e) => {
              setDraft(e.target.value);
              const cleaned = e.target.value.replace(/,/g, "").replace(/\s/g, "");
              if (cleaned === "" || cleaned === "-" || cleaned === ".") return;
              const n = Number(cleaned);
              if (Number.isFinite(n)) onChange(n);
            }}
            onBlur={(e) => {
              setEditing(false);
              const cleaned = e.target.value.replace(/,/g, "").replace(/\s/g, "");
              const n = Number(cleaned);
              if (!Number.isFinite(n) || cleaned === "") { onChange(min); setDraft(formatForInput(min)); return; }
              const clamped = Math.max(min, Math.min(max, n));
              onChange(clamped);
              setDraft(formatForInput(clamped));
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="text-sm tabular-nums text-right w-32 px-1.5 py-0.5 border border-slate-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:bg-slate-100"
          />
          {suffix && <span className="text-sm text-slate-500">{suffix}</span>}
        </div>
      </div>
      <Slider disabled={!!disabled} value={[value]} onValueChange={(v) => onChange(v[0])} min={min} max={max} step={step} />
    </div>
  );
}
function PercentSlider({ label, value, onChange, disabled = false }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) { return <NumberSlider label={label} min={0} max={100} step={0.1} value={value} onChange={onChange} suffix="%" disabled={disabled} />; }
function Notes({ children, title = "Notes & equations (what & why)" }: { children: React.ReactNode; title?: string }) { return (<div className="rounded-lg bg-slate-100 border p-3 text-xs leading-relaxed text-slate-500 space-y-2"><div className="flex items-center gap-2 font-medium"><Info className="w-4 h-4" /> {title}</div><div className="space-y-1">{children}</div></div>); }
function ColorKey({items}:{items:{c:string;t:string;v?:number;pct?:string;stroke?:boolean}[]}){
  return(
    <div className="flex flex-wrap gap-4 text-[10px] mt-2">
      {items.map((it,i)=>(
        <div key={i} className="flex items-center gap-2">
          <span className={`inline-block w-3 h-3 ${it.stroke?"border border-black":""}`} style={{background:undefined}}>
            <span className={`inline-block w-3 h-3 rounded ${it.c}`}></span>
          </span>
          <span className="text-gray-600">
            {it.t}{typeof it.v==="number"? `: ${fmtUSD(it.v,2)}`:""}{it.pct? ` (${it.pct})`:""}
          </span>
        </div>))}
    </div>
  )
}

function BlockDiagram({L,T,U,fee,burn,tips,excess,userPaysB,right:{burnB,paidEthB,nonEthB,earnedProvB,earnedSeqB}}:{L:number;T:number;U:number;fee:number;burn:number;tips:number;excess:number;userPaysB:number;right:{burnB:number;paidEthB:number;nonEthB:number;earnedProvB:number;earnedSeqB:number;}}){
  // Dimensions and layout
  const W=520, H=220, pad=12; const yBot=H-pad; const innerH=H-2*pad;
  const leftX=10, leftW=140; const rightW=140; const gutter=40; const xRight=leftX+leftW+gutter;
  // Scales
  const h=(v:number)=>Math.max(0,(v/Math.max(1e-9,L))*innerH);
  const usedH=h(U); const targetY=yBot-h(T);

  // RHS segments sized by % of User Pays
  const seqMinusTips = Math.max(0, earnedSeqB - tips);
  const userPays = Math.max(0, userPaysB);
  const containerH = usedH>0 ? usedH : innerH;

  const segs = [
    { key: 'burn', label: 'Burn', val: burnB, fill: '#FF1A1A' },
    { key: 'eth', label: 'Burned ETH', val: paidEthB, fill: '#2BFAE9' },
    { key: 'noneth', label: 'Non‑ETH Costs', val: nonEthB, fill: '#918B7F' },
    { key: 'prov', label: 'Prover Earnings', val: earnedProvB, fill: '#FF2DF4' },
    { key: 'seq', label: 'Sequencer Earnings (− tips)', val: seqMinusTips, fill: '#D4FF28' },
    { key: 'tips', label: 'Tips', val: tips, fill: '#16A34A' },
  ];
  const totalStack = segs.reduce((sum, s) => sum + Math.max(0, s.val), 0);
  const denom = userPays > 0 ? userPays : Math.max(1e-9, totalStack);
  const segsWithH = segs.map(s=>({ ...s, h: containerH * (Math.max(0, s.val)/denom) }));

  // Legend items at bottom with $ and % of User Pays
  const pct = (v:number)=> userPays>0 ? `${((Math.max(0,v)/denom)*100).toFixed(1)}%` : undefined;
  const legendItems = [
    { c: 'bg-[#FF1A1A]/80', t: 'Burn', v: burnB, pct: pct(burnB) },
    { c: 'bg-[#2BFAE9]/70', t: 'Burned ETH', v: paidEthB, pct: pct(paidEthB) },
    { c: 'bg-[#918B7F]', t: 'Non‑ETH Costs', v: nonEthB, pct: pct(nonEthB) },
    { c: 'bg-[#FF2DF4]/80', t: 'Prover Earnings', v: earnedProvB, pct: pct(earnedProvB) },
    { c: 'bg-[#D4FF28]/80', t: 'Sequencer Earnings (− tips)', v: seqMinusTips, pct: pct(seqMinusTips) },
    { c: 'bg-[#16A34A]/80', t: 'Tips', v: tips, pct: pct(tips) },
  ];

  return (
    <div className="flex gap-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full bg-white rounded-xl">
        {/* Bar labels */}
        <text x={leftX + leftW/2} y={Math.max(10, pad - 3)} textAnchor="middle" className="fill-slate-600 text-[11px]">utilisation</text>
        <text x={xRight + rightW/2} y={Math.max(10, pad - 3)} textAnchor="middle" className="fill-slate-600 text-[11px]">user fee flow</text>
        {/* Left bar: mana usage */}
        <rect x={leftX} y={pad} width={leftW} height={innerH} rx={12} className="fill-gray-100 stroke-gray-300"/>
        <rect x={leftX} y={yBot-usedH} width={leftW} height={usedH} rx={10} className="fill-gray-800/10"/>
        <line x1={leftX} x2={leftX+leftW} y1={targetY} y2={targetY} className="stroke-red-500" strokeWidth={2}/>
        {excess>0 && (<text x={leftX+5} y={targetY-4} className="fill-red-600 text-[9px]">excess mana: {fmtNum(excess,0)}</text>)}

        {/* Right bar: user pays breakdown */}
        <rect x={xRight} y={pad} width={rightW} height={innerH} rx={12} className="fill-gray-100 stroke-gray-300"/>
        <rect x={xRight} y={yBot-containerH} width={rightW} height={containerH} rx={10} className="fill-gray-800/10"/>
        {(() => { let y=yBot; return (
          <g>
            {segsWithH.map(s=>{ const h=s.h; if(h<=2 || s.val<=0) return null; const y1=y-h; const el=(<rect key={s.key} x={xRight} y={y1} width={rightW} height={h} rx={8} style={{fill:s.fill,opacity:0.9}}/>); y=y1; return el; })}
          </g>
        ); })()}
      </svg>

      {/* Legend on RHS, vertical, matching Governance & Issuance font size, vertically centered */}
      <div className="mt-0 self-center">
        <div className="flex flex-col gap-2 text-sm">
          {legendItems.map((it,i)=> (
            <div key={i} className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded" style={{background: undefined}}>
                <span className={`inline-block w-3 h-3 rounded ${it.c}`}></span>
              </span>
              <span className="text-slate-600">
                {it.t}{typeof it.v==="number"? `: ${fmtUSD(it.v,2)}`:""}{it.pct? ` (${it.pct})`: ""}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AztecFeeModel_V6(){
  const [net, setNet] = useState<NetworkParams>(DEFAULT.net);
  const [cost, setCost] = useState<CostParams>(DEFAULT.cost);
  const [cong, setCong] = useState<CongestionParams>(DEFAULT.cong);
  const [gov, setGov] = useState<GovParams>(DEFAULT.gov);
  const [seq, setSeq] = useState<SequencerParams>(DEFAULT.seq);
  const [userWillingUSD, setUserWillingUSD] = useState<number>(0.1);
  // Operator Economics (What-if) state: operator runs a fleet of sequencers partly on own stake,
  // partly on delegated stake; charges a commission on delegator rewards.
  const [opTotalStakeAZTEC, setOpTotalStakeAZTEC] = useState<number>(10_000_000);
  const [opOwnStakePct, setOpOwnStakePct] = useState<number>(10);
  const [opCommissionPct, setOpCommissionPct] = useState<number>(5);
  // Prover Economics state. Provers compete per epoch - number is flexible (not bounded by stake).
  // Rewards split by consistency-weighted shares: weight(c) = c^alpha. Higher alpha rewards
  // consistency more steeply (alpha=0 everyone equal, 1 linear share, 2 quadratic, etc).
  const [numProvers, setNumProvers] = useState<number>(5);
  const [thisProverConsistencyPct, setThisProverConsistencyPct] = useState<number>(95);
  const [otherProversConsistencyPct, setOtherProversConsistencyPct] = useState<number>(90);
  const [consistencyCurveAlpha, setConsistencyCurveAlpha] = useState<number>(2);
  const [oraclePremiumPct, setOraclePremiumPct] = useState<number>(0);
  const [stage, setStage] = useState<StageName>("Alpha");
  const [valuationUSD, setValuationUSD] = useState<number>(DEFAULT.gov.maxSupplyTokens * DEFAULT.gov.tokenPriceUSD);
  const [wfScale, setWfScale] = useState<'per_tx'|'per_block'|'per_epoch'|'per_day'|'per_month'|'per_year'|'pct_staked'|'pct_fdv'>("per_year");
  useEffect(()=>{
    const p = PRESETS[stage];
    setNet(p.net);
    setCost(p.cost);
    setCong(p.cong);
    setGov(p.gov);
    setSeq(p.seq);
    // Stage-specific default valuations
    if(stage === "Ignition") setValuationUSD(250_000_000);
    if(stage === "Alpha") setValuationUSD(p.gov.maxSupplyTokens * p.gov.tokenPriceUSD);
    if(stage === "Beta") setValuationUSD(1_000_000_000);
    // Stage-specific default user willingness to pay
    if(stage === "Alpha") setUserWillingUSD(0.10);
    if(stage === "Beta") setUserWillingUSD(0.05);
  },[stage]);
  // Derive token price from assumed FDV: price = FDV / max supply
  const govForModel: GovParams = gov.maxSupplyTokens > 0 ? { ...gov, tokenPriceUSD: valuationUSD / gov.maxSupplyTokens } : gov;
  const m = useModel(net, cost, cong, govForModel, seq, oraclePremiumPct);

  // Intentionally omitting debug identity checks to satisfy lint rules

  // Currency-conversion helpers: protocol-native denominations (ETH for L1 costs, AZTEC for rewards/fees/burn).
  const toETH = (usd: number) => cost.ethPrice > 0 ? usd / cost.ethPrice : 0;
  const toAZTEC = (usd: number) => govForModel.tokenPriceUSD > 0 ? usd / govForModel.tokenPriceUSD : 0;

  // Live prices (Etherscan + public RPC) cached in localStorage for 1h.
  const prices = usePrices();
  const [pricesApplied, setPricesApplied] = useState<boolean>(false);
  useEffect(() => {
    if (!prices.data || pricesApplied) return;
    const p = prices.data;
    let changed = false;
    const nextCost = { ...cost };
    if (p.ethPriceUSD && p.ethPriceUSD > 0) { nextCost.ethPrice = p.ethPriceUSD; changed = true; }
    const gasGwei = p.gasPriceGwei.avg30d ?? p.gasPriceGwei.current;
    if (gasGwei && gasGwei > 0) { nextCost.l1GasPriceGwei = gasGwei; changed = true; }
    if (p.blobGasPriceGwei && p.blobGasPriceGwei > 0) { nextCost.blobGasPriceGwei = p.blobGasPriceGwei; changed = true; }
    if (changed) setCost(nextCost);
    if (p.aztecPriceUSD && p.aztecPriceUSD > 0 && gov.maxSupplyTokens > 0) {
      setValuationUSD(p.aztecPriceUSD * gov.maxSupplyTokens);
    }
    setPricesApplied(true);
  }, [prices.data, pricesApplied, cost, gov.maxSupplyTokens]);

  const headroomUSD = Math.max(0, userWillingUSD - m.totalUserFeeUSD_tx);

  // Operator fleet economics: N sequencers built on operator's total stake. Income splits into
  // (1) full rewards from own-stake portion, (2) commission % of rewards from delegator stake.
  // L1 costs are borne entirely by the operator (no cost pass-through to delegators).
  const opNumSequencers = Math.max(0, opTotalStakeAZTEC / Math.max(1, seq.stakePerSequencer));
  const opOwnStakeAZTEC = opTotalStakeAZTEC * (opOwnStakePct / 100);
  const opDelegatedStakeAZTEC = opTotalStakeAZTEC - opOwnStakeAZTEC;
  const opOwnStakeUSD = opOwnStakeAZTEC * govForModel.tokenPriceUSD;
  const opNetworkStakeSharePct = m.stakedTokens > 0 ? (opTotalStakeAZTEC / m.stakedTokens) * 100 : 0;

  const opGrossIssuanceUSDPerYear = m.sequencer_issuance_USD_per_year * opNumSequencers;
  const opGrossIssuanceAZTECPerYear = m.sequencer_issuance_AZTEC_per_year * opNumSequencers;
  const opGrossFeesUSDPerYear = m.sequencer_fee_earnings_USD_per_year * opNumSequencers;
  const opGrossFeesAZTECPerYear = m.sequencer_fee_earnings_AZTEC_per_year * opNumSequencers;
  const opGrossTotalUSDPerYear = opGrossIssuanceUSDPerYear + opGrossFeesUSDPerYear;
  const opGrossTotalAZTECPerYear = opGrossIssuanceAZTECPerYear + opGrossFeesAZTECPerYear;
  const opL1CostsUSDPerYear = m.sequencer_L1_costs_USD_per_year * opNumSequencers;
  const opL1CostsETHPerYear = m.sequencer_L1_costs_ETH_per_year * opNumSequencers;
  const opTotalCostsUSDPerYear = opL1CostsUSDPerYear;

  const ownStakeFrac = opOwnStakePct / 100;
  const delStakeFrac = 1 - ownStakeFrac;
  const commFrac = opCommissionPct / 100;
  const opFromOwnStakeUSDPerYear = opGrossTotalUSDPerYear * ownStakeFrac;
  const opFromOwnStakeAZTECPerYear = opGrossTotalAZTECPerYear * ownStakeFrac;
  const opCommissionIncomeUSDPerYear = opGrossTotalUSDPerYear * delStakeFrac * commFrac;
  const opCommissionIncomeAZTECPerYear = opGrossTotalAZTECPerYear * delStakeFrac * commFrac;
  const opGrossIncomeUSDPerYear = opFromOwnStakeUSDPerYear + opCommissionIncomeUSDPerYear;
  const opGrossIncomeAZTECPerYear = opFromOwnStakeAZTECPerYear + opCommissionIncomeAZTECPerYear;
  const opNetEBITDAUSDPerYear = opGrossIncomeUSDPerYear - opTotalCostsUSDPerYear;
  const opAPYOnOwnStakePct = opOwnStakeUSD > 0 ? (opNetEBITDAUSDPerYear / opOwnStakeUSD) * 100 : 0;
  const delegatorNetRewardsUSDPerYear = opGrossTotalUSDPerYear * delStakeFrac * (1 - commFrac);
  const delegatorNetRewardsAZTECPerYear = opGrossTotalAZTECPerYear * delStakeFrac * (1 - commFrac);
  const delegatorStakeUSD = opDelegatedStakeAZTEC * govForModel.tokenPriceUSD;
  const delegatorAPYPct = delegatorStakeUSD > 0 ? (delegatorNetRewardsUSDPerYear / delegatorStakeUSD) * 100 : 0;

  // ---- Per-Prover Economics ----
  // Per-epoch: on-time provers share the reward pool in proportion to consistency weight c_i^alpha.
  // Over a year: this prover only claims their share on epochs they actually finish on time
  // (c_self fraction of epochs), so effective_annual_share = share_when_active × c_self.
  // This makes consistency affect TOTAL earnings (not just relative split), and makes doubling
  // provers-of-equal-consistency halve per-prover earnings cleanly.
  const proverAlpha = Math.max(0, consistencyCurveAlpha);
  const selfC = Math.max(0, Math.min(1, thisProverConsistencyPct / 100));
  const otherC = Math.max(0, Math.min(1, otherProversConsistencyPct / 100));
  const selfWeight = Math.pow(selfC, proverAlpha);
  const otherWeight = Math.pow(otherC, proverAlpha);
  const totalWeight = selfWeight + Math.max(0, numProvers - 1) * otherWeight;
  const proverShareWhenActive = totalWeight > 0 ? selfWeight / totalWeight : 0;
  const proverEffectiveShare = proverShareWhenActive * selfC;
  const proverShareWhenActivePct = proverShareWhenActive * 100;
  const proverEffectiveSharePct = proverEffectiveShare * 100;
  const equalSharePct = numProvers > 0 ? 100 / numProvers : 0;

  const proverBlocksPerYear = m.blocksPerDay * 365;
  const proverEpochsPerYear = proverBlocksPerYear / Math.max(1, net.blocksPerEpoch);
  // Total rewards to ALL provers per year (issuance + fee share).
  const totalProverIssuanceUSDPerYear = m.issuanceToProversUSDPerBlock * proverBlocksPerYear;
  const totalProverIssuanceAZTECPerYear = toAZTEC(totalProverIssuanceUSDPerYear);
  const totalProverFeeUSDPerYear = m.provRevenueUSD_tx * m.txPerBlock * proverBlocksPerYear;
  const totalProverFeeAZTECPerYear = toAZTEC(totalProverFeeUSDPerYear);
  const totalProverRevenueUSDPerYear = totalProverIssuanceUSDPerYear + totalProverFeeUSDPerYear;
  const totalProverRevenueAZTECPerYear = totalProverIssuanceAZTECPerYear + totalProverFeeAZTECPerYear;
  // This prover's effective share accounts for both split-when-active AND attendance rate.
  const thisProverIssuanceAZTECPerYear = totalProverIssuanceAZTECPerYear * proverEffectiveShare;
  const thisProverIssuanceUSDPerYear = totalProverIssuanceUSDPerYear * proverEffectiveShare;
  const thisProverFeeAZTECPerYear = totalProverFeeAZTECPerYear * proverEffectiveShare;
  const thisProverFeeUSDPerYear = totalProverFeeUSDPerYear * proverEffectiveShare;
  const thisProverRevenueAZTECPerYear = thisProverIssuanceAZTECPerYear + thisProverFeeAZTECPerYear;
  const thisProverRevenueUSDPerYear = thisProverIssuanceUSDPerYear + thisProverFeeUSDPerYear;
  // Oracle-priced compute subsidy baked into this prover's fee revenue. Shown so operators can see
  // how much of their fee share is compensation for compute vs other components. Not a "cost" here:
  // actual hardware cost depends on each prover's rig and is excluded (like sequencer infrastructure).
  const thisProverTxPerYear = m.txPerBlock * proverBlocksPerYear * selfC;
  const thisProverOracleComputeSubsidyUSDPerYear = cost.proverComputeUSDPerTx * thisProverTxPerYear;
  // L1 submission cost: one on-chain verify per epoch; whoever submits first pays. Assume this
  // prover's L1 submission rate matches their effective annual share (submitter picked proportionally).
  const verifyUSDPerEpoch = cost.proofVerifyGasPerEpoch * (cost.l1GasPriceGwei * 1e-9) * cost.ethPrice;
  const thisProverL1VerifyUSDPerYear = verifyUSDPerEpoch * proverEpochsPerYear * proverEffectiveShare;
  const thisProverL1VerifyETHPerYear = toETH(thisProverL1VerifyUSDPerYear);

  const thisProverTotalCostsUSDPerYear = thisProverL1VerifyUSDPerYear;
  const thisProverNetUSDPerYear = thisProverRevenueUSDPerYear - thisProverTotalCostsUSDPerYear;
  const thisProverMarginPct = thisProverRevenueUSDPerYear > 0 ? (thisProverNetUSDPerYear / thisProverRevenueUSDPerYear) * 100 : 0;

  const U = m.blockManaUsed;
  const feeB = m.baseFeePerManaUSD * U;
  const burnB = m.burnPerManaUSD * U;
  const tipsB = m.tipPerManaUSD * U;
  const seqCostB = m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE;
  const provCostB = m.proverOnchainUSDPerBlock_FIXED;

  const subsidyUSD_tx = m.proverSubsidyUSDPerBlock_FIXED / Math.max(1, m.txPerBlock);
  const nonETHCosts_tx = cost.proverComputeUSDPerTx + subsidyUSD_tx;

  const seqNetPos_tx = Math.max(0, m.seqNetUSD_tx);
  const provNetPos_tx = Math.max(0, m.provNetUSD_tx);
  const seqInflationPerTx = m.txPerBlock > 0 ? m.issuanceToSequencersUSDPerBlock / m.txPerBlock : 0;
  const provInflationPerTx = m.txPerBlock > 0 ? m.issuanceToProversUSDPerBlock / m.txPerBlock : 0;
  const seqTotalNetPerTx = m.seqNetUSD_tx + seqInflationPerTx;
  const provTotalNetPerTx = m.provNetUSD_tx + provInflationPerTx;

  const paidToETH_block = (m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE) + m.proverOnchainUSDPerBlock_FIXED;
  const subsidy_block = m.proverSubsidyUSDPerBlock_FIXED;
  const inflation_block = m.issuanceToOperatorsUSDPerBlock;

  const seqFlow = stage === "Ignition"
    ? [
        { name: "Burned ETH (per slot)", val: paidToETH_block, k: "eth" },
        { name: "Non‑ETH Subsidy (per slot)", val: subsidy_block, k: "noneth" },
        { name: "Inflation to Operators (per slot)", val: inflation_block, k: "infl" }
      ]
    : [
        { name: "Burn", val: m.burnUSD_tx, k: "burn" },
        { name: "Burned ETH", val: m.passThroughFeesToETH_tx, k: "eth" },
        { name: "Non‑ETH Costs (Prover)", val: nonETHCosts_tx, k: "noneth" },
        { name: "Earned by Provers", val: provNetPos_tx, k: "prov" },
        { name: "Earned by Sequencers", val: seqNetPos_tx, k: "seq" },
        { name: "User Pays", total: m.totalUserFeeUSD_tx, k: "pay" },
        { name: "Headroom", val: headroomUSD, k: "head" },
        { name: "User Willingness", total: userWillingUSD, k: "will" }
      ];
  type FlowRow = { name: string; k: string; val?: number; total?: number };
  type WaterfallRow = { name: string; base: number; delta: number; k: string };
  const baseIsBlock = stage === "Ignition";
  const isPercentMode = wfScale === 'pct_staked' || wfScale === 'pct_fdv';
  const fdvUSD_total = gov.maxSupplyTokens * govForModel.tokenPriceUSD;
  const denomUSD = wfScale === 'pct_staked' ? (m.stakedTokens * govForModel.tokenPriceUSD) : (wfScale === 'pct_fdv' ? fdvUSD_total : 0);
  const factor = (() => {
    if (isPercentMode) return 1; // percent uses an annual basis scalar below
    if (baseIsBlock) {
      switch (wfScale) {
        case 'per_tx': return 1/Math.max(1, m.txPerBlock);
        case 'per_block': return 1;
        case 'per_epoch': return Math.max(1, net.blocksPerEpoch);
        case 'per_day': return m.blocksPerDay;
        case 'per_month': return m.blocksPerDay * 30;
        case 'per_year': return m.blocksPerDay * 365;
        default: return 1;
      }
    } else {
      switch (wfScale) {
        case 'per_tx': return 1;
        case 'per_block': return m.txPerBlock;
        case 'per_epoch': return m.txPerBlock * Math.max(1, net.blocksPerEpoch);
        case 'per_day': return m.txPerDay;
        case 'per_month': return m.txPerDay * 30;
        case 'per_year': return m.txPerDay * 365;
        default: return 1;
      }
    }
  })();
  const annualFactor = baseIsBlock ? (m.blocksPerDay * 365) : (m.txPerDay * 365);
  let cum = 0; const wf: WaterfallRow[] = (seqFlow as FlowRow[]).map((r) => {
    const isTotal = !!r.total;
    const raw = (isTotal ? (r.total as number) : (r.val as number)) || 0;
    const scaled = isPercentMode ? (raw * annualFactor) : (raw * factor);
    const delta = isPercentMode ? (denomUSD > 0 ? (scaled / denomUSD) * 100 : 0) : scaled;
    const base = isTotal ? 0 : cum;
    if(!isTotal) cum += delta;
    return { name: r.name, base, delta, k: r.k };
  });

  const colorOf: Record<string,string> = {
    pay: "#1A1400", // ink
    eth: "#2BFAE9", // aqua
    burn: "#FF1A1A", // vermillion
    seq: "#D4FF28", // chartreuse
    prov: "#FF2DF4", // orchid
    noneth: "#918B7F", // parchment mid
    head: "#22C8BA", // aqua mid
    will: "#00122E", // lapis
    infl: "#2E0026"  // aubergine
  };
  const pct = (v:number)=> m.totalUserFeeUSD_tx>0? (v/m.totalUserFeeUSD_tx)*100:0;

  function WFTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
    if (!active || !payload || payload.length === 0) return null;
    const datum = (payload.find((p)=>p && p.dataKey === "delta")?.payload || payload[0].payload) as WaterfallRow;
    const k = datum.k;
    const tip = { title: datum.name, eq: "", sub: "" } as { title: string; eq: string; sub: string };

    const baseComp = m.baseComponentPerManaUSD_BILLED;
    const mult = m.congestionMultiplier;
    const mana = net.manaPerTx;
    const tipPct = cong.tipPctOfBase / 100;
    const seqCostPerTx = m.seqFixedUSDPerTx + m.l1USDPerTx_DA;
    const provCostPerTx = m.l1USDPerTx_Verify;
    const feesRetained = m.feeBaseUSD_tx + m.feeTipUSD_tx - m.burnUSD_tx;

    if (k === "infl") {
      tip.eq = "inflation (per slot) = issuanceToOperatorsUSDPerSlot";
      tip.sub = `= ${fmtUSD(m.issuanceToOperatorsUSDPerBlock,4)}`;
    } else if (k === "burn") {
      tip.eq = "burnUSD_tx = max(0, baseComponentPerManaUSD_BILLED × (congestionMultiplier − 1)) × manaPerTx";
      tip.sub = `= max(0, ${baseComp.toFixed(8)} × (${mult.toFixed(4)} − 1)) × ${fmtNum(mana,0)} = ${fmtUSD(m.burnUSD_tx,6)}`;
    } else if (k === "eth") {
      if(stage === "Ignition"){
        tip.eq = "Burned ETH (per slot) = sequencer L1 per slot + prover verify per slot";
        tip.sub = `= ${fmtUSD((m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE),4)} + ${fmtUSD(m.proverOnchainUSDPerBlock_FIXED,4)}`;
      }else{
        tip.eq = "burnedETH_tx = min(seqCostPerTx, feesRetained) + min(provCostPerTx, max(0, feesRetained − min(seqCostPerTx, feesRetained)))";
        tip.sub = `seqCostPerTx=${fmtUSD(seqCostPerTx,6)}, provCostPerTx=${fmtUSD(provCostPerTx,6)}, feesRetained=${fmtUSD(feesRetained,6)} ⇒ ${fmtUSD(m.passThroughFeesToETH_tx,6)}`;
      }
    } else if (k === "noneth") {
      if(stage === "Ignition"){
        tip.eq = "Non‑ETH Subsidy (per slot) = prover subsidy per slot";
        tip.sub = `= ${fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,4)}`;
      }else{
        tip.eq = "nonETHCosts_tx = proverComputeUSDPerTx + subsidyPerBlock/txPerBlock";
        tip.sub = `${fmtUSD(cost.proverComputeUSDPerTx,6)} + ${fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,6)} / ${fmtNum(m.txPerBlock,2)} = ${fmtUSD(cost.proverComputeUSDPerTx + (m.proverSubsidyUSDPerBlock_FIXED/Math.max(1,m.txPerBlock)),6)}`;
      }
    } else if (k === "prov") {
      tip.eq = "provNetUSD_tx = (baseComponentPerManaUSD_BILLED × proverShare × manaPerTx) − (l1USDPerTx_Verify + proverComputeUSD_tx)";
      tip.sub = `= (${baseComp.toFixed(8)} × ${(cong.proverShareOfUnburnedBase*100).toFixed(1)}% × ${fmtNum(mana,0)}) − (${fmtUSD(m.l1USDPerTx_Verify,6)} + ${fmtUSD(cost.proverComputeUSDPerTx,6)}) = ${fmtUSD(m.provNetUSD_tx,6)}`;
    } else if (k === "seq") {
      tip.eq = "seqNetUSD_tx = (baseComponentPerManaUSD_BILLED × (1 − proverShare) × manaPerTx + feeTipUSD_tx) − (l1USDPerTx_DA + seqFixedUSDPerTx)";
      tip.sub = `= (${baseComp.toFixed(8)} × ${(100 - cong.proverShareOfUnburnedBase*100).toFixed(1)}% × ${fmtNum(mana,0)} + ${fmtUSD(m.feeTipUSD_tx,6)}) − (${fmtUSD(m.l1USDPerTx_DA,6)} + ${fmtUSD(m.seqFixedUSDPerTx,6)}) = ${fmtUSD(m.seqNetUSD_tx,6)}`;
    } else if (k === "pay") {
      tip.eq = "totalUserFeeUSD_tx = feeBaseUSD_tx + feeTipUSD_tx; feeBaseUSD_tx = baseFeePerManaUSD × manaPerTx; feeTipUSD_tx = baseFeePerManaUSD × tip% × manaPerTx";
      tip.sub = `= (${fmtUSD(m.baseFeePerManaUSD,8)} × ${fmtNum(mana,0)}) + (${fmtUSD(m.baseFeePerManaUSD,8)} × ${(tipPct*100).toFixed(1)}% × ${fmtNum(mana,0)}) = ${fmtUSD(m.totalUserFeeUSD_tx,6)}`;
    } else if (k === "head") {
      tip.eq = "headroomUSD = max(0, userWillingUSD − totalUserFeeUSD_tx)";
      tip.sub = `= max(0, ${fmtUSD(userWillingUSD,4)} − ${fmtUSD(m.totalUserFeeUSD_tx,6)}) = ${fmtUSD(Math.max(0, userWillingUSD - m.totalUserFeeUSD_tx),6)}`;
    } else if (k === "will") {
      tip.eq = "userWillingUSD (input)";
      tip.sub = `= ${fmtUSD(userWillingUSD,4)}`;
    }

    return (
      <div className="rounded-md bg-white/95 shadow p-2 text-[11px] space-y-1">
        <div className="font-medium text-slate-700">{tip.title}</div>
        {tip.eq && <div className="text-slate-500">{tip.eq}</div>}
        {tip.sub && <div className="text-slate-700">{tip.sub}</div>}
      </div>
    );
  }

  return (
    <div className="p-6 grid grid-cols-1 xl:grid-cols-12 gap-6">
      <Card className="shadow-sm xl:col-span-12"><CardHeader className="pb-3"><CardTitle>Live Market Data (Etherscan + public RPC)</CardTitle></CardHeader><CardContent>
        {(() => {
          const p = prices.data;
          const fmtAgo = (d: Date | null) => {
            if (!d) return "never";
            const secs = Math.floor((Date.now() - d.getTime()) / 1000);
            if (secs < 60) return `${secs}s ago`;
            if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
            return `${Math.floor(secs/3600)}h ago`;
          };
          const fmtTime = (d: Date | null) => d ? d.toLocaleString() : "-";
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <div><span className="text-slate-500">ETH:</span> <span className="font-medium tabular-nums">{p?.ethPriceUSD ? fmtUSD(p.ethPriceUSD, 2) : "-"}</span></div>
                <div><span className="text-slate-500">AZTEC:</span> <span className="font-medium tabular-nums">{p?.aztecPriceUSD ? fmtUSD(p.aztecPriceUSD, 4) : "-"}</span></div>
                <div><span className="text-slate-500">Gas (30d avg):</span> <span className="font-medium tabular-nums">{p?.gasPriceGwei.avg30d ? `${p.gasPriceGwei.avg30d.toFixed(2)} gwei` : (p?.gasPriceGwei.current ? `${p.gasPriceGwei.current.toFixed(2)} gwei (current)` : "-")}</span></div>
                <div><span className="text-slate-500">Blob gas (current):</span> <span className="font-medium tabular-nums">{p?.blobGasPriceGwei != null ? `${p.blobGasPriceGwei.toFixed(4)} gwei` : "-"}</span></div>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-slate-500" title={fmtTime(prices.lastFetched)}>Updated {fmtAgo(prices.lastFetched)}{prices.cacheHit ? " (cached)" : ""}</span>
                  <button onClick={prices.refresh} disabled={prices.loading} className="text-xs px-2 py-1 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50">
                    {prices.loading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-slate-500">
                Gas price is a 30-day rolling average of daily averages from Etherscan. Blob gas is current (no free historical endpoint). Cached in your browser for 1 hour to limit API calls. Auto-applies on first load of a session; further changes to sliders override the live values.
              </div>
              {p && p.errors && p.errors.length > 0 && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  <span className="font-medium">Warnings:</span> {p.errors.join(" · ")}
                </div>
              )}
            </div>
          );
        })()}
      </CardContent></Card>

      <Card className="shadow-sm xl:col-span-12"><CardHeader className="pb-3"><CardTitle>Per‑Transaction Breakdown (Income Statement)</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-slate-600">Network Stage</div>
          <select className="border rounded px-2 py-1 text-sm" value={stage} onChange={(e)=> setStage(e.target.value as any)}>
            <option>Ignition</option>
            <option>Alpha</option>
            <option>Beta</option>
          </select>
        </div>
        <Notes title="Terminology (post‑Alpha)">
          <div><b>Slot</b>: L2 publishing window ({net.blockTime}s). One checkpoint is posted to L1 per slot. $AZTEC rewards accrue per published slot.</div>
          <div><b>Block</b>: sub‑unit of a slot (Alpha lets sequencers build {net.blocksPerSlot} blocks per slot). Blocks are bundled into the slot&apos;s checkpoint.</div>
          <div><b>Checkpoint</b>: the payload of blocks for a slot, published to L1 as one transaction.</div>
          <div><b>Epoch</b>: {net.blocksPerEpoch} slots ({fmtNum(net.blocksPerEpoch * net.blockTime / 60, 1)} min). Committee selection, proof window, and slashing rounds operate at epoch scale.</div>
        </Notes>
        {stage !== "Ignition" && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-slate-600">Waterfall View</div>
            <select className="border rounded px-2 py-1 text-sm" value={wfScale} onChange={(e)=> setWfScale(e.target.value as any)}>
              <option value="per_tx">Per tx</option>
              <option value="per_block">Per slot</option>
              <option value="per_epoch">Per epoch</option>
              <option value="per_day">Per day</option>
              <option value="per_month">Per month</option>
              <option value="per_year">Per year</option>
              <option value="pct_staked">% vs Staked Supply (USD)</option>
              <option value="pct_fdv">% vs FDV (USD)</option>
            </select>
          </div>
        )}
        {stage !== "Ignition" && (
          <div className="flex items-center justify-end">
            <div className="w-full md:w-[360px]">
            <NumberSlider label="User Willingness to Pay ($/tx)" min={0} max={2} step={0.005} value={userWillingUSD} onChange={setUserWillingUSD} />
            </div>
          </div>
        )}
        {stage !== "Ignition" ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">User Currently Pays</div><div className="text-right font-medium tabular-nums">{fmtNum(toAZTEC(m.totalUserFeeUSD_tx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(m.totalUserFeeUSD_tx,6)})</span></div>
            <div className="text-slate-500">Network burns (congestion)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(m.burnUSD_tx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(m.burnUSD_tx,6)} · {fmtNum(pct(m.burnUSD_tx),2)}%)</span></div>
            <div className="text-slate-500">Burned ETHereum</div><div className="text-right tabular-nums">{fmtNum(toETH(m.passThroughFeesToETH_tx), 8)} ETH <span className="text-slate-400">({fmtUSD(m.passThroughFeesToETH_tx,6)} · {fmtNum(pct(m.passThroughFeesToETH_tx),2)}%)</span></div>
            <div className="text-slate-500">Prover Non‑ETH Costs (compute + subsidy)</div><div className="text-right">{fmtUSD(nonETHCosts_tx,6)} ({fmtNum(pct(nonETHCosts_tx),2)}%)</div>
            <div className="text-slate-500">Earned by Sequencers (fees − costs)</div><div className={`text-right tabular-nums ${m.seqNetUSD_tx < 0 ? 'text-rose-700' : ''}`}>{fmtNum(toAZTEC(m.seqNetUSD_tx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(m.seqNetUSD_tx,6)} · {fmtNum(pct(m.seqNetUSD_tx),2)}%)</span></div>
            <div className="text-slate-500">Earned by Provers (fees − costs)</div><div className={`text-right tabular-nums ${m.provNetUSD_tx < 0 ? 'text-rose-700' : ''}`}>{fmtNum(toAZTEC(m.provNetUSD_tx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(m.provNetUSD_tx,6)} · {fmtNum(pct(m.provNetUSD_tx),2)}%)</span></div>
            <div className="col-span-2 pt-2 border-t text-xs text-slate-500">Plus AZTEC inflation (per tx, from 500 AZTEC/slot block reward):</div>
            <div className="text-slate-500">+ Inflation to Sequencers</div><div className="text-right text-emerald-700 tabular-nums">{fmtNum(toAZTEC(seqInflationPerTx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(seqInflationPerTx,6)})</span></div>
            <div className="text-slate-500">+ Inflation to Provers</div><div className="text-right text-emerald-700 tabular-nums">{fmtNum(toAZTEC(provInflationPerTx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(provInflationPerTx,6)})</span></div>
            <div className="col-span-2 pt-2 border-t" />
            <div className="text-slate-500 font-medium">Net Sequencer (fees + inflation − costs)</div><div className={`text-right font-semibold tabular-nums ${seqTotalNetPerTx < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{fmtNum(toAZTEC(seqTotalNetPerTx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(seqTotalNetPerTx,6)})</span></div>
            <div className="text-slate-500 font-medium">Net Prover (fees + inflation − costs)</div><div className={`text-right font-semibold tabular-nums ${provTotalNetPerTx < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{fmtNum(toAZTEC(provTotalNetPerTx), 4)} AZTEC <span className="text-slate-400">({fmtUSD(provTotalNetPerTx,6)})</span></div>
            <div className="col-span-2 text-[10px] text-slate-400 italic mt-1">Suppressed in earlier versions: fee-only net clamped to 0. Now showing raw value so the subsidy from inflation is explicit.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-sm">
            {(() => { const burnedEthUSD = m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE + m.proverOnchainUSDPerBlock_FIXED; return (<>
              <div className="text-slate-500">Burned ETHereum (per slot)</div><div className="text-right font-medium tabular-nums">{fmtNum(toETH(burnedEthUSD), 8)} ETH <span className="text-slate-400">({fmtUSD(burnedEthUSD,4)})</span></div>
            </>); })()}
            <div className="text-slate-500">Non‑ETH Subsidy (per slot)</div><div className="text-right tabular-nums">{fmtNum(toETH(m.proverSubsidyUSDPerBlock_FIXED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,4)})</span></div>
            <div className="text-slate-500">Inflation to Operators (per slot)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(m.issuanceToOperatorsUSDPerBlock), 2)} AZTEC <span className="text-slate-400">({fmtUSD(m.issuanceToOperatorsUSDPerBlock,4)})</span></div>
            <div className="text-slate-500">Net Issuance after Burn (per slot)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(m.netIssuanceAfterBurnUSDPerBlock), 2)} AZTEC <span className="text-slate-400">({fmtUSD(m.netIssuanceAfterBurnUSDPerBlock,4)})</span></div>
          </div>
        )}
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={wf} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
              <XAxis dataKey="name" /><YAxis tickFormatter={(v)=> (wfScale==='pct_staked'||wfScale==='pct_fdv') ? `${(v as number).toFixed(2)}%` : `$${(v as number).toFixed(2)}`} />
              <Tooltip content={<WFTooltip />} />
              <Bar dataKey="base" stackId="w" fill="#00000000" />
              <Bar dataKey="delta" stackId="w">
                {wf.map((it, i) => (<Cell key={i} fill={colorOf[it.k] || "#94a3b8"} />))}
                <LabelList dataKey={(d:any)=>{
                  const k=d.k; const val=d.delta as number;
                  const show=["burn","eth","noneth","prov","seq"].includes(k) && stage!=="Ignition";
                  if(!show) return "";
                  // Percent modes: val is already a % of denom; show as-is
                  if(wfScale==='pct_staked' || wfScale==='pct_fdv'){
                    return `${(val as number).toFixed(1)}%`;
                  }
                  // Dollar modes: compute percent vs scaled User Pays total
                  const txScale = (():number=>{
                    switch(wfScale){
                      case 'per_tx': return 1;
                      case 'per_block': return Math.max(1, m.txPerBlock);
                      case 'per_epoch': return Math.max(1, m.txPerBlock) * Math.max(1, net.blocksPerEpoch);
                      case 'per_day': return m.txPerDay;
                      case 'per_month': return m.txPerDay * 30;
                      case 'per_year': return m.txPerDay * 365;
                      default: return 1;
                    }
                  })();
                  const scaledUserPays = m.totalUserFeeUSD_tx * txScale;
                  if(scaledUserPays<=0) return "";
                  return `${((val/scaledUserPays)*100).toFixed(1)}%`;
                }} position="top" className="fill-[#1A1400] text-[10px]"/>
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Economic throughput summary across timeframes */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Economic Throughput</div>
          {(() => {
            const perBlock_user = stage === "Ignition" ? 0 : (m.totalUserFeeUSD_tx * m.txPerBlock);
            const perBlock_paidETH = stage === "Ignition" ? paidToETH_block : (m.passThroughFeesToETH_tx * m.txPerBlock);
            const perBlock_nonETH = stage === "Ignition" ? subsidy_block : (nonETHCosts_tx * m.txPerBlock);
            const perBlock_burn = m.burnUSD_tx * m.txPerBlock;
            const perBlock_issuance = m.issuanceToOperatorsUSDPerBlock;
            const perBlock_seqEarn = Math.max(0, m.seqNetUSD_tx) * m.txPerBlock;
            const perBlock_provEarn = Math.max(0, m.provNetUSD_tx) * m.txPerBlock;
            const perBlock_earned = perBlock_seqEarn + perBlock_provEarn;
            const pctOfUser = (v:number)=> perBlock_user>0 ? ((v/perBlock_user)*100) : 0;
            const blocksPerYear = m.blocksPerDay * 365;
            const stakedUSD = m.stakedTokens * govForModel.tokenPriceUSD;
            const feesAPR = stakedUSD>0 ? ((perBlock_earned*blocksPerYear)/stakedUSD)*100 : 0;
            const rows = [
              { t: "Per slot", mult: 1 },
              { t: "Per epoch", mult: Math.max(1, net.blocksPerEpoch) },
              { t: "Per day", mult: m.blocksPerDay },
              { t: "Per month", mult: m.blocksPerDay * 30 },
              { t: "Per year", mult: m.blocksPerDay * 365 },
            ];
            return (
              <div className="grid grid-cols-9 gap-x-2 gap-y-1 text-[11px] md:text-xs">
                <div className="text-slate-500"></div>
                <div className="text-slate-500 text-right">Burn</div>
                <div className="text-slate-500 text-right">Burned ETH</div>
                <div className="text-slate-500 text-right">Non‑ETH costs</div>
                <div className="text-slate-500 text-right">Earned (Provers)</div>
                <div className="text-slate-500 text-right">Earned (Seq)</div>
                <div className="text-slate-500 text-right">User Fees</div>
                <div className="text-slate-500 text-right">Fees APR & stake</div>
                <div className="text-slate-500 text-right">Issuance</div>
                {rows.map((r, i) => (
                  <React.Fragment key={`row-${i}`}>
                    <div className="text-slate-600">{r.t}</div>
                    <div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlock_burn * r.mult), 2)} AZTEC</div>
                    <div className="text-right tabular-nums">{fmtNum(toETH(perBlock_paidETH * r.mult), 6)} ETH</div>
                    <div className="text-right">{fmtUSD(perBlock_nonETH * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_provEarn * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_seqEarn * r.mult, 2)}</div>
                    <div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlock_user * r.mult), 2)} AZTEC</div>
                    <div className="text-right">{fmtNum(feesAPR,2)}% @ {fmtNum(gov.stakeRatePct,1)}%</div>
                    <div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlock_issuance * r.mult), 2)} AZTEC</div>
                  </React.Fragment>
                ))}
              </div>
            );
          })()}
        </div>
      </CardContent></Card>

      <div className="xl:col-span-5 space-y-6">
        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Assumptions</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label="Assumed FDV (USD)" min={50_000_000} max={2_000_000_000} step={5_000_000} value={valuationUSD} onChange={setValuationUSD} prefix="$" />
          <PercentSlider label="Staked Share of Circulating (%)" value={gov.stakeRatePct} onChange={(v)=> setGov({ ...gov, stakeRatePct: v })} />
          <PercentSlider label="Annual Issuance on Max Supply (%)" value={gov.issuanceRateOnMaxPct} onChange={(v)=> setGov({ ...gov, issuanceRateOnMaxPct: v })} />
          
          <PercentSlider label="Issuance Share to Sequencers (%)" value={gov.operatorIssuanceSeqSharePct} onChange={(v)=> setGov({ ...gov, operatorIssuanceSeqSharePct: v })} />
          <PercentSlider label="Issuance Share to Provers (%)" value={gov.operatorIssuanceProvSharePct} onChange={(v)=> setGov({ ...gov, operatorIssuanceProvSharePct: v })} />
        </CardContent></Card>
        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Configurable Utilisation</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label={`User Demanded TPS${stage==="Alpha" ? " (Alpha cap ≈ 1)" : ""}`} min={0} max={stage==="Beta" ? 200 : 5} step={0.01} value={net.tps} onChange={(v) => setNet({ ...net, tps: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Slot Duration (s)" min={2} max={72} step={1} value={net.blockTime} onChange={(v) => setNet({ ...net, blockTime: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Slots per Epoch" min={6} max={64} step={1} value={net.blocksPerEpoch} onChange={(v) => setNet({ ...net, blocksPerEpoch: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Blocks per Slot (sub-blocks bundled per checkpoint)" min={1} max={12} step={1} value={net.blocksPerSlot} onChange={(v) => setNet({ ...net, blocksPerSlot: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Max Tx per Checkpoint (hard cap)" min={1} max={10_000} step={1} value={net.maxTxPerCheckpoint} onChange={(v) => setNet({ ...net, maxTxPerCheckpoint: v })} disabled={stage==="Ignition"} />
          <div className="pt-2 border-t" />
          <CardTitle className="text-base">Tx Details</CardTitle>
          <NumberSlider label="Tx Mana Cost (mana/tx)" min={5_000} max={2_000_000} step={1_000} value={net.manaPerTx} onChange={(v) => setNet({ ...net, manaPerTx: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Tx DA size (bytes)" min={200} max={200_000} step={50} value={net.bytesPerTxDA} onChange={(v) => setNet({ ...net, bytesPerTxDA: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="ETH Price (USD)" min={500} max={10000} step={10} value={cost.ethPrice} onChange={(v) => setCost({ ...cost, ethPrice: v })} />
          <NumberSlider label="L1 Gas Price (gwei)" min={0} max={50} step={0.1} value={cost.l1GasPriceGwei} onChange={(v) => setCost({ ...cost, l1GasPriceGwei: v })} />
          <NumberSlider label="L1 Blob Gas Price (gwei)" min={0} max={20} step={0.1} value={cost.blobGasPriceGwei} onChange={(v) => setCost({ ...cost, blobGasPriceGwei: v })} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Epoch Time</div><div className="text-right font-medium">{fmtNum(m.epochTimeSec, 0)} s</div><div className="text-slate-500">Tx / Slot (demand / mana / DA / cap)</div><div className="text-right">{fmtNum(m.txPerBlockDemand, 2)} / {fmtNum(m.txPerBlockCapacity_mana, 0)} / {fmtNum(m.maxTxPerBlock_byBlob, 0)} / {fmtNum(net.maxTxPerCheckpoint, 0)}</div><div className="text-slate-500">Tx / Slot (effective)</div><div className="text-right font-medium">{fmtNum(m.txPerBlock, 2)}</div><div className="text-slate-500">TPS limits (mana / DA)</div><div className="text-right">{fmtNum(m.tpsLimitByMana, 2)} / {fmtNum(m.tpsLimitByBlobs, 2)}</div></div>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Congestion & Burn Configuration</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label={`BLOBS_PER_BLOCK (billed constant, per slot)`} min={1} max={100} step={1} value={cong.blobsPerBlockPolicy} onChange={(v) => setCong({ ...cong, blobsPerBlockPolicy: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Minimum Congestion Multiplier" min={1} max={20} step={0.01} value={cong.minMultiplier} onChange={(v) => setCong({ ...cong, minMultiplier: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Mana Target per Slot" min={5_000_000} max={200_000_000} step={250_000} value={cong.manaTarget} onChange={(v) => setCong({ ...cong, manaTarget: v, manaLimit: Math.max(v*2, cong.manaLimit) })} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Mana Limit per Slot (2× target)</div><div className="text-right font-medium">{fmtNum(cong.manaTarget*2,0)}</div></div>
          <PercentSlider label="Tip as % of Base" value={cong.tipPctOfBase} onChange={(v) => setCong({ ...cong, tipPctOfBase: v })} disabled={stage==="Ignition"} />
          <PercentSlider label="Prover share of unburned base" value={cong.proverShareOfUnburnedBase * 100} onChange={(v) => setCong({ ...cong, proverShareOfUnburnedBase: v / 100 })} disabled={stage==="Ignition"} />
          <PercentSlider label="Prover Oracle Premium (%)" value={oraclePremiumPct} onChange={setOraclePremiumPct} disabled={stage==="Ignition"} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Min Fee</div><div className="text-right font-medium">{fmtUSD(m.baseFeePerManaUSD, 8)} / mana</div><div className="text-slate-500">Min Fee</div><div className="text-right">{fmtNum(m.baseFeePerManaGwei, 8)} gwei / mana</div><div className="text-slate-500">Mana per Gwei</div><div className="text-right">{fmtNum(m.manaPerGwei, 8)} mana / gwei</div></div>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Operator Economics (What‑if)</CardTitle></CardHeader><CardContent className="space-y-3">
          <NumberSlider label="Total Stake Operated (AZTEC)" min={10_000} max={500_000_000} step={1} value={opTotalStakeAZTEC} onChange={setOpTotalStakeAZTEC} />
          <PercentSlider label="Own Stake (% of operated)" value={opOwnStakePct} onChange={setOpOwnStakePct} />
          <PercentSlider label="Commission on Delegator Rewards (%)" value={opCommissionPct} onChange={setOpCommissionPct} />
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-500 pt-2 border-t">
            <div>Sequencers Operated</div><div className="text-right font-medium tabular-nums text-slate-700">{fmtNum(opNumSequencers, 2)}</div>
            <div>Network Stake Share</div><div className="text-right tabular-nums">{fmtNum(opNetworkStakeSharePct, 2)}%</div>
            <div>Own Stake</div><div className="text-right tabular-nums">{fmtNum(opOwnStakeAZTEC, 0)} AZTEC ({fmtUSD(opOwnStakeUSD, 2)})</div>
            <div>Delegated Stake</div><div className="text-right tabular-nums">{fmtNum(opDelegatedStakeAZTEC, 0)} AZTEC ({fmtUSD(delegatorStakeUSD, 2)})</div>
          </div>
          <div className="pt-2 border-t" />
          <div className="text-sm font-medium text-emerald-700">Annual Gross Rewards (fleet)</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Issuance</div><div className="text-right tabular-nums">{fmtNum(opGrossIssuanceAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opGrossIssuanceUSDPerYear, 2)})</span></div>
            <div className="text-slate-500">Tx Fees</div><div className="text-right tabular-nums">{fmtNum(opGrossFeesAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opGrossFeesUSDPerYear, 2)})</span></div>
            <div className="text-slate-500 font-medium">Total Gross</div><div className="text-right font-medium tabular-nums">{fmtNum(opGrossTotalAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opGrossTotalUSDPerYear, 2)})</span></div>
          </div>
          <div className="text-sm font-medium">Operator Income Split</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">From Own Stake (100% kept)</div><div className="text-right tabular-nums">{fmtNum(opFromOwnStakeAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opFromOwnStakeUSDPerYear, 2)})</span></div>
            <div className="text-slate-500">Commission on Delegator Rewards</div><div className="text-right tabular-nums">{fmtNum(opCommissionIncomeAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opCommissionIncomeUSDPerYear, 2)})</span></div>
            <div className="text-slate-500 font-medium">Operator Gross Income</div><div className="text-right font-medium tabular-nums">{fmtNum(opGrossIncomeAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(opGrossIncomeUSDPerYear, 2)})</span></div>
            <div className="text-slate-500 text-[11px]">(Delegators keep)</div><div className="text-right text-[11px] text-slate-400 tabular-nums">{fmtNum(delegatorNetRewardsAZTECPerYear, 0)} AZTEC ({fmtUSD(delegatorNetRewardsUSDPerYear, 2)})</div>
          </div>
          <div className="text-sm font-medium text-rose-700">Annual Protocol Costs (paid by operator)</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">L1 Gas + Blobs</div><div className="text-right tabular-nums">{fmtNum(opL1CostsETHPerYear, 4)} ETH <span className="text-slate-400">({fmtUSD(opL1CostsUSDPerYear, 2)})</span></div>
            <div className="text-slate-500 font-medium">Total Costs</div><div className="text-right font-medium tabular-nums">{fmtUSD(opTotalCostsUSDPerYear, 2)}</div>
          </div>
          <div className="pt-2 border-t" />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500 font-medium">Pre‑Infrastructure EBITDA / Year</div><div className={`text-right font-semibold tabular-nums ${opNetEBITDAUSDPerYear >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtUSD(opNetEBITDAUSDPerYear, 2)}</div>
            <div className="text-slate-500">APY on Own Stake (pre‑infra)</div><div className={`text-right font-semibold tabular-nums ${opAPYOnOwnStakePct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtNum(opAPYOnOwnStakePct, 2)}%</div>
            <div className="text-slate-500">Delegator APY (net of commission)</div><div className="text-right tabular-nums">{fmtNum(delegatorAPYPct, 2)}%</div>
          </div>
          <Notes title="Model">
            <div><b>Infrastructure costs excluded.</b> Only on-chain L1 costs (gas + blobs) are shown. Real-world hosting, monitoring, bandwidth, and ops staff cost must be subtracted separately. Factor that in based on your fleet size and deployment outside the dashboard.</div>
            <div>Operator runs <code>{fmtNum(opNumSequencers, 1)}</code> sequencers (total stake / stake per sequencer). Rewards per sequencer come from the Per‑Sequencer Economics card.</div>
            <div>Commission applies only to delegator‑stake rewards. Operator keeps 100% of rewards from own stake + commission % of delegator rewards, pays all L1 costs.</div>
            <div>APY on own stake = (Net EBITDA / Own Stake Value), pre‑infrastructure.</div>
          </Notes>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Per-Sequencer Economics</CardTitle></CardHeader><CardContent className="space-y-3">
          <NumberSlider label="Assumed Stake per Sequencer (AZTEC)" min={1_000} max={2_000_000} step={1} value={seq.stakePerSequencer} onChange={(v)=> setSeq({ ...seq, stakePerSequencer: v })} />
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
            <div>Target Committee Size</div><div className="text-right tabular-nums">{seq.targetCommitteeSize}</div>
            <div>Min Stake (Ejection Floor)</div><div className="text-right tabular-nums">{fmtNum(seq.minSequencerStake, 0)} AZTEC</div>
            <div>Proof Submission Window</div><div className="text-right tabular-nums">{seq.proofSubmissionEpochs} epoch</div>
          </div>
          <div className="pt-2 border-t" />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Approx Active Sequencers</div><div className="text-right font-medium tabular-nums">{fmtNum(m.numActiveSequencers, 0)}</div>
            <div className="text-slate-500">Slots Proposed / Sequencer / Year</div><div className="text-right tabular-nums">{fmtNum(m.slotsPerSequencerPerYear, 1)}</div>
            <div className="text-slate-500">Stake Value</div><div className="text-right tabular-nums">{fmtNum(seq.stakePerSequencer, 0)} AZTEC <span className="text-slate-400">({fmtUSD(m.sequencer_stake_USD, 2)})</span></div>
          </div>
          <div className="pt-2 border-t" />
          <div className="text-sm font-medium text-emerald-700">Annual Earnings</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Slot Rewards (issuance, per published checkpoint)</div>
            <div className="text-right tabular-nums">{fmtNum(m.sequencer_issuance_AZTEC_per_year, 0)} AZTEC <span className="text-slate-400">({fmtUSD(m.sequencer_issuance_USD_per_year, 2)})</span></div>
            <div className="text-slate-500">Tx Fees</div><div className="text-right tabular-nums">{fmtNum(m.sequencer_fee_earnings_AZTEC_per_year, 0)} AZTEC <span className="text-slate-400">({fmtUSD(m.sequencer_fee_earnings_USD_per_year, 2)})</span></div>
            <div className="text-slate-500 font-medium">Total</div><div className="text-right font-medium tabular-nums">{fmtNum(m.sequencer_total_earnings_AZTEC_per_year, 0)} AZTEC <span className="text-slate-400">({fmtUSD(m.sequencer_total_earnings_USD_per_year, 2)})</span></div>
          </div>
          <div className="text-sm font-medium text-rose-700">Annual Protocol Costs</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">L1 Gas + Blobs</div>
            <div className="text-right tabular-nums">{fmtNum(m.sequencer_L1_costs_ETH_per_year, 4)} ETH <span className="text-slate-400">({fmtUSD(m.sequencer_L1_costs_USD_per_year, 2)})</span></div>
            <div className="text-slate-500 font-medium">Total Costs</div><div className="text-right font-medium tabular-nums">{fmtUSD(m.sequencer_total_costs_USD_per_year, 2)}</div>
          </div>
          <div className="pt-2 border-t" />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Net USD / Year</div><div className={`text-right font-semibold tabular-nums ${m.sequencer_net_USD_per_year >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtUSD(m.sequencer_net_USD_per_year, 2)}</div>
            <div className="text-slate-500">Issuance-only APY</div><div className="text-right tabular-nums">{fmtNum(m.sequencer_issuance_APY_pct, 2)}%</div>
            <div className="text-slate-500 font-medium">Net APY (pre‑infrastructure)</div><div className={`text-right font-semibold tabular-nums ${m.sequencer_APY_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtNum(m.sequencer_APY_pct, 2)}%</div>
          </div>
          <Notes title="Assumptions">
            <div><b>Infrastructure costs excluded.</b> This card shows pre-infrastructure economics only: issuance + fees, minus on-chain L1 costs (propose gas, proof verification, blobs). Server hosting, monitoring, bandwidth, on-call, and operational staff must be subtracted separately. Factor those in outside the dashboard based on your own deployment.</div>
            <div>Active sequencers ≈ total staked ÷ assumed stake per sequencer. Uniform proposer rotation (1/N slots each).</div>
            <div>Sequencer-side only: earnings = (operator issuance × {fmtNum(gov.operatorIssuanceSeqSharePct,0)}% seq share) + fees on proposed slots. Prover rewards go to a separate set.</div>
          </Notes>
        </CardContent></Card>

      </div>

      <div className="xl:col-span-7 space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>L2 Cost per L1 Slot – Sequencer</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="text-sm font-medium">Fixed</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-slate-500">Exec Gas (propose, incl setupEpoch)</div><div className="text-right tabular-nums">{fmtNum(toETH(m.seqExecUSDPerBlock_GAS_FIXED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.seqExecUSDPerBlock_GAS_FIXED,6)})</span></div>
              <div className="text-slate-500">Proposal Blob (1×)</div><div className="text-right tabular-nums">{fmtNum(toETH(m.proposalBlobUSDPerBlock_FIXED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.proposalBlobUSDPerBlock_FIXED,6)})</span></div>
            </div>
            <div className="text-sm font-medium">Variable</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-slate-500">DA Blobs (actual posted, {fmtNum(m.dataBlobsUsed, 0)} blob{m.dataBlobsUsed === 1 ? "" : "s"})</div><div className="text-right tabular-nums">{fmtNum(toETH(m.seqBlobUSDPerBlock_VARIABLE), 8)} ETH <span className="text-slate-400">({fmtUSD(m.seqBlobUSDPerBlock_VARIABLE,6)})</span></div>
              <div className="text-slate-500">DA Blobs (billed, <code>BLOBS_PER_BLOCK</code>={fmtNum(cong.blobsPerBlockPolicy, 0)})</div><div className="text-right tabular-nums">{fmtNum(toETH(m.seqBlobUSDPerBlock_BILLED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.seqBlobUSDPerBlock_BILLED,6)})</span></div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500"><div>Inputs (Exec Gas)</div><div className="text-right">{fmtNum(cost.l1ExecGasPerBlock,0)} gas × {cost.l1GasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div><div>Inputs (Proposal Blob)</div><div className="text-right">1 × 2^17 × {cost.blobGasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div></div>
            <Notes title="Actual vs Billed DA (per design doc)">
              <div>Per the Aztec fee design, the base fee charges users for a <b>constant</b> <code>BLOBS_PER_BLOCK</code> ({fmtNum(cong.blobsPerBlockPolicy, 0)} on Alpha) regardless of tx count — so users pay a predictable DA price.</div>
              <div>The sequencer actually posts a <b>variable</b> number of blobs based on real tx volume. When usage &lt; BLOBS_PER_BLOCK the sequencer profits from the unused billed capacity; when usage &gt; BLOBS_PER_BLOCK the sequencer eats the overage (the <code>maxTxPerCheckpoint</code> cap is meant to prevent this in practice).</div>
            </Notes>
          </CardContent></Card>

          <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>L2 Cost per L1 Slot – Prover</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="text-sm font-medium">Fixed</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-slate-500">Verify (on-chain, per epoch)</div><div className="text-right tabular-nums">{fmtNum(toETH(m.proverOnchainUSDPerBlock_FIXED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.proverOnchainUSDPerBlock_FIXED,6)})</span></div>
              <div className="text-slate-500">Subsidy (2× verifiers)</div><div className="text-right tabular-nums">{fmtNum(toETH(m.proverSubsidyUSDPerBlock_FIXED), 8)} ETH <span className="text-slate-400">({fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,6)})</span></div>
            </div>
            <div className="text-sm font-medium">Variable</div>
            <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Oracle Premium</div><div className="text-right">{fmtNum(oraclePremiumPct,2)}%</div></div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500"><div>Inputs (Verify)</div><div className="text-right">{fmtNum(cost.proofVerifyGasPerEpoch,0)} gas × {cost.l1GasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div></div>
          </CardContent></Card>
        </div>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Per-Prover Economics</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <NumberSlider label="Number of Competing Provers" min={1} max={50} step={1} value={numProvers} onChange={setNumProvers} />
            <NumberSlider label="Consistency Curve Exponent (α)" min={0} max={5} step={0.1} value={consistencyCurveAlpha} onChange={setConsistencyCurveAlpha} />
            <PercentSlider label="This Prover's Consistency (on-time epochs %)" value={thisProverConsistencyPct} onChange={setThisProverConsistencyPct} />
            <PercentSlider label="Other Provers' Avg Consistency (%)" value={otherProversConsistencyPct} onChange={setOtherProversConsistencyPct} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-500 pt-2 border-t">
            <div>Per-Epoch Split (when you&apos;re on-time)</div><div className="text-right tabular-nums">{fmtNum(proverShareWhenActivePct, 2)}% <span className="text-slate-400">(equal-weight: {fmtNum(equalSharePct, 2)}%)</span></div>
            <div>Effective Annual Share (split × consistency)</div><div className="text-right font-medium tabular-nums text-slate-700">{fmtNum(proverEffectiveSharePct, 2)}%</div>
            <div>Consistency Boost vs Equal</div><div className="text-right tabular-nums">{equalSharePct > 0 ? `${((proverShareWhenActivePct / equalSharePct - 1) * 100).toFixed(1)}%` : "–"}</div>
            <div>Epochs Proven / Year</div><div className="text-right tabular-nums">{fmtNum(proverEpochsPerYear * selfC, 0)} / {fmtNum(proverEpochsPerYear, 0)}</div>
            <div>Total Prover Rewards / Year (all provers)</div><div className="text-right tabular-nums">{fmtNum(totalProverRevenueAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(totalProverRevenueUSDPerYear, 2)})</span></div>
          </div>
          <div className="pt-2 border-t" />
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="text-sm font-medium text-emerald-700">Annual Revenue (this prover)</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-slate-500">Issuance Share</div><div className="text-right tabular-nums">{fmtNum(thisProverIssuanceAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(thisProverIssuanceUSDPerYear, 2)})</span></div>
                <div className="text-slate-500">Fee Share</div><div className="text-right tabular-nums">{fmtNum(thisProverFeeAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(thisProverFeeUSDPerYear, 2)})</span></div>
                <div className="text-slate-500 font-medium">Total Revenue</div><div className="text-right font-medium tabular-nums">{fmtNum(thisProverRevenueAZTECPerYear, 0)} AZTEC <span className="text-slate-400">({fmtUSD(thisProverRevenueUSDPerYear, 2)})</span></div>
                <div className="text-slate-500 text-[11px]">└ of which oracle compute subsidy</div><div className="text-right text-[11px] text-slate-400 tabular-nums">{fmtUSD(thisProverOracleComputeSubsidyUSDPerYear, 2)}</div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-rose-700">Annual Protocol Costs (this prover)</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-slate-500">L1 Verify Submissions</div><div className="text-right tabular-nums">{fmtNum(thisProverL1VerifyETHPerYear, 4)} ETH <span className="text-slate-400">({fmtUSD(thisProverL1VerifyUSDPerYear, 2)})</span></div>
                <div className="text-slate-500 font-medium">Total Costs</div><div className="text-right font-medium">{fmtUSD(thisProverTotalCostsUSDPerYear, 2)}</div>
              </div>
            </div>
          </div>
          <div className="pt-2 border-t" />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500 font-medium">Net / Year (pre-infrastructure)</div><div className={`text-right font-semibold tabular-nums ${thisProverNetUSDPerYear >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtUSD(thisProverNetUSDPerYear, 2)}</div>
            <div className="text-slate-500">Gross Margin</div><div className={`text-right tabular-nums ${thisProverMarginPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtNum(thisProverMarginPct, 1)}%</div>
          </div>
          <Notes title="Model">
            <div><b>Infrastructure costs excluded.</b> Real ZK-compute costs (GPU rigs, electricity, cooling, ops) are NOT subtracted here. The protocol does bake an oracle-priced compute subsidy ({fmtUSD(cost.proverComputeUSDPerTx, 6)}/tx) into the fee revenue above, so provers are partly compensated; subtract your own actual hardware cost outside the dashboard to get your real margin.</div>
            <div><b>Reward split.</b> In each epoch, on-time provers split the pool by weight(c) = c<sup>α</sup>. Per-epoch split = w(self) / (w(self) + (N−1) × w(others)). Higher α concentrates rewards toward the most consistent provers.</div>
            <div><b>Annual effective share = per-epoch split × your consistency.</b> Doubling equally-consistent provers halves per-prover earnings cleanly; with differing consistency, the more consistent prover earns a premium.</div>
            <div><b>L1 verify.</b> Submission assumed awarded proportionally to effective share — this prover pays {fmtNum(proverEffectiveSharePct, 1)}% of annual on-chain verify gas.</div>
          </Notes>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Blob usage as TPS rises</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-slate-500">ETH Max / L2 Slot (ceiling)</div><div className="text-right">{fmtNum(m.ethBlobBudgetPerL2Block, 0)} ({fmtNum(net.maxBlobsPerEthBlock, 0)} / ETH block)</div>
          <div className="text-slate-500">ETH Target / L2 Slot (sustainable)</div><div className="text-right">{fmtNum(m.ethBlobTargetPerL2Block, 0)} ({fmtNum(net.targetBlobsPerEthBlock, 0)} / ETH block)</div>
          <div className="text-slate-500">Policy Blobs / L2 Slot</div><div className="text-right">{fmtNum(m.policyBlobCap, 0)}</div>
          <div className="text-slate-500">Proposal Blobs (of available)</div><div className="text-right">{m.proposalBlobsPerBlock} / {fmtNum(m.ethBlobBudgetPerL2Block,0)}</div>
          <div className="text-slate-500">Data Blobs (of available)</div><div className="text-right">{m.dataBlobsUsed} / {fmtNum(m.ethBlobBudgetPerL2Block,0)}</div>
          <div className="text-slate-500">Total Blobs (of available)</div><div className="text-right font-medium">{m.blobsUsed} / {fmtNum(m.ethBlobBudgetPerL2Block,0)}</div>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Governance & Issuance</CardTitle></CardHeader><CardContent className="space-y-4">
          {(() => {
            const circPct = gov.maxSupplyTokens>0 ? (m.circTokens / gov.maxSupplyTokens) * 100 : 0;
            const stakedPctOfCirc = m.circTokens>0 ? (m.stakedTokens / m.circTokens) * 100 : 0;
            const fdvUSD = gov.maxSupplyTokens * govForModel.tokenPriceUSD;
            const perBlockIss = m.issuanceUSDPerBlock;
            const perBlockSeq = m.issuanceToSequencersUSDPerBlock;
            const perBlockProv = m.issuanceToProversUSDPerBlock;
            const perBlockBurn = m.burnUSDPerBlock;
            const perBlockNetInflation = m.netIssuanceAfterBurnUSDPerBlock;
            const blocksPerYear = m.blocksPerDay * 365;
            const stakedUSD = m.stakedTokens * govForModel.tokenPriceUSD;
            const circUSD = m.circTokens * govForModel.tokenPriceUSD;
            const perBlockEarned = (Math.max(0,m.seqNetUSD_tx)+Math.max(0,m.provNetUSD_tx)) * m.txPerBlock;
            const feesAPR = stakedUSD>0 ? ((perBlockEarned*blocksPerYear)/stakedUSD)*100 : 0;
            const inflAPY = m._stakerAPYPct; // issuance-only APY basis
            const netInflPctAnnual = stakedUSD>0 ? ((perBlockNetInflation*blocksPerYear)/stakedUSD)*100 : 0;
            const inflPctAnnual = stakedUSD>0 ? ((perBlockIss*blocksPerYear)/stakedUSD)*100 : 0;
            const burnPctAnnual = stakedUSD>0 ? ((perBlockBurn*blocksPerYear)/stakedUSD)*100 : 0;
            return (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-slate-500">Circulating Supply (tokens)</div><div className="text-right">{fmtNum(m.circTokens,0)} ({fmtNum(circPct,1)}% of Max)</div>
                  <div className="text-slate-500">Staked Supply (tokens)</div><div className="text-right">{fmtNum(m.stakedTokens,0)} ({fmtNum(stakedPctOfCirc,1)}% of Circ)</div>
                  <div className="text-slate-500">Token Price (Derived)</div><div className="text-right">{fmtUSD(govForModel.tokenPriceUSD,4)}</div>
                  <div className="text-slate-500">Circ Market Cap</div><div className="text-right">{fmtUSDSig4(m.circTokens * govForModel.tokenPriceUSD)}</div>
                  <div className="text-slate-500">FDV</div><div className="text-right">{fmtUSDSig4(fdvUSD)}</div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="font-medium text-slate-700">Slot Reward (per published checkpoint)</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-500">- Sequencers ({fmtNum(gov.operatorIssuanceSeqSharePct,1)}%)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlockSeq), 2)} AZTEC <span className="text-slate-400">({fmtUSD(perBlockSeq,4)})</span></div>
                    <div className="text-slate-500">- Provers ({fmtNum(gov.operatorIssuanceProvSharePct,1)}%)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlockProv), 2)} AZTEC <span className="text-slate-400">({fmtUSD(perBlockProv,4)})</span></div>
                    {m.issuanceToOtherUSDPerBlock > 0 && (
                      <>
                        <div className="text-slate-500">- Retained/Other ({fmtNum(Math.max(0, 100 - gov.operatorIssuanceSeqSharePct - gov.operatorIssuanceProvSharePct),1)}%)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(m.issuanceToOtherUSDPerBlock), 2)} AZTEC <span className="text-slate-400">({fmtUSD(m.issuanceToOtherUSDPerBlock,4)})</span></div>
                      </>
                    )}
                    <div className="text-slate-500">- Burnt (congestion)</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(perBlockBurn), 2)} AZTEC <span className="text-slate-400">({fmtUSD(perBlockBurn,4)})</span></div>
                  </div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="font-medium text-slate-700">Staker APY</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-500">- Fee APR</div><div className="text-right">{fmtNum(feesAPR,2)}%</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-500">- Net Inflation (Inflation − Burn)</div>
                    <div className="text-right">{fmtNum(netInflPctAnnual,2)}% ({fmtNum(inflPctAnnual,2)}% − {fmtNum(burnPctAnnual,2)}%)</div>
                  </div>
                </div>
              </>
            );
          })()}
          
          {stage === "Ignition" && (
            <Notes title="Coverage & Pure Inflation">
              <div>Coverage ratio (operators): issuance_to_operators / (paid_to_eth + non_eth_subsidy)</div>
              <div className="font-medium">{fmtUSD(m.issuanceToOperatorsUSDPerBlock,4)} / {fmtUSD((m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE + m.proverOnchainUSDPerBlock_FIXED) + m.proverSubsidyUSDPerBlock_FIXED,4)}</div>
            </Notes>
          )}
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Slot Diagram</CardTitle></CardHeader><CardContent className="space-y-3">
          <BlockDiagram L={cong.manaTarget*2} T={cong.manaTarget} U={U} fee={feeB} burn={burnB} tips={tipsB} excess={m.excessMana} userPaysB={m.totalUserFeeUSD_tx*m.txPerBlock} right={{
            burnB: m.burnUSD_tx*m.txPerBlock,
            paidEthB: m.passThroughFeesToETH_tx*m.txPerBlock,
            nonEthB: (cost.proverComputeUSDPerTx + (m.proverSubsidyUSDPerBlock_FIXED/Math.max(1,m.txPerBlock))) * m.txPerBlock,
            earnedProvB: Math.max(0,m.provNetUSD_tx)*m.txPerBlock,
            earnedSeqB: Math.max(0,m.seqNetUSD_tx)*m.txPerBlock
          }} />
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Business Case – Annual Income Statement (Sequencer & Prover)</CardTitle></CardHeader><CardContent className="grid md:grid-cols-2 gap-6 text-sm">
          {(() => {
            const blocksPerYear = m.blocksPerDay * 365;
            const txPerYear = m.txPerBlock * blocksPerYear;
            // Sequencer per year
            const seqRevenueY = m.seqRevenueUSD_tx * txPerYear;
            const seqFixedY = m.seqFixedUSDPerTx * txPerYear;
            const seqDaY = m.l1USDPerTx_DA * txPerYear;
            const seqVariableY = seqDaY;
            const seqMarginY = m.seqNetUSD_tx * txPerYear;
            const seqMarginPct = seqRevenueY > 0 ? (seqMarginY / seqRevenueY) * 100 : 0;
            const seqTipsY = m.feeTipUSD_tx * txPerYear;
            const seqIssuanceY = m.issuanceToSequencersUSDPerBlock * blocksPerYear;
            const seqMarginInclIssY = seqMarginY + seqIssuanceY;
            const seqBaseSharePerTx = m.toSequencerPerManaUSD * net.manaPerTx;
            const seqBaseShareY = seqBaseSharePerTx * txPerYear;

            // Prover per year
            const provRevenueY = m.provRevenueUSD_tx * txPerYear;
            const provFixedY = m.l1USDPerTx_Verify * txPerYear;
            const provVariableY = cost.proverComputeUSDPerTx * txPerYear;
            const provMarginY = m.provNetUSD_tx * txPerYear;
            const provMarginPct = provRevenueY > 0 ? (provMarginY / provRevenueY) * 100 : 0;
            const provIssuanceY = m.issuanceToProversUSDPerBlock * blocksPerYear;
            const provMarginInclIssY = provMarginY + provIssuanceY;
            const provBaseSharePerTx = m.toProverPerManaUSD * net.manaPerTx;
            const provBaseShareY = provBaseSharePerTx * txPerYear;

            return (
              <>
                <div className="space-y-2">
                  <div className="font-medium">Sequencer</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-600">Revenue</div><div></div>
                    <div className="text-slate-500">- Base share / year</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(seqBaseShareY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(seqBaseShareY,2)})</span></div>
                    <div className="text-slate-500">- Tips / year</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(seqTipsY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(seqTipsY,2)})</span></div>
                    <div className="text-slate-700">Total revenue / year</div><div className="text-right font-medium tabular-nums">{fmtNum(toAZTEC(seqRevenueY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(seqRevenueY,2)})</span></div>
                    <div className="text-slate-600 pt-1">Costs</div><div className="pt-1"></div>
                    <div className="text-slate-500">- DA variable / year</div><div className="text-right tabular-nums">{fmtNum(toETH(seqDaY), 4)} ETH <span className="text-slate-400">({fmtUSD(seqDaY,2)})</span></div>
                    <div className="text-slate-500">- Fixed / year</div><div className="text-right tabular-nums">{fmtNum(toETH(seqFixedY), 4)} ETH <span className="text-slate-400">({fmtUSD(seqFixedY,2)})</span></div>
                    <div className="text-slate-700">Total costs / year</div><div className="text-right font-medium tabular-nums">{fmtNum(toETH(seqVariableY + seqFixedY), 4)} ETH <span className="text-slate-400">({fmtUSD(seqVariableY + seqFixedY,2)})</span></div>
                    <div className="text-slate-700">Operating margin / year</div><div className="text-right font-medium">{fmtUSD(seqMarginY,2)} ({fmtNum(seqMarginPct,1)}%)</div>
                    <div className="text-slate-500">Issuance credit / year</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(seqIssuanceY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(seqIssuanceY,2)})</span></div>
                    <div className="text-slate-700">Net margin incl issuance / year</div><div className="text-right font-medium">{fmtUSD(seqMarginInclIssY,2)}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="font-medium">Prover</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-600">Revenue</div><div></div>
                    <div className="text-slate-500">- Base share / year</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(provBaseShareY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(provBaseShareY,2)})</span></div>
                    <div className="text-slate-700">Total revenue / year</div><div className="text-right font-medium tabular-nums">{fmtNum(toAZTEC(provRevenueY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(provRevenueY,2)})</span></div>
                    <div className="text-slate-600 pt-1">Costs</div><div className="pt-1"></div>
                    <div className="text-slate-500">- Verify (L1) / year</div><div className="text-right tabular-nums">{fmtNum(toETH(provFixedY), 4)} ETH <span className="text-slate-400">({fmtUSD(provFixedY,2)})</span></div>
                    <div className="text-slate-500">- Compute / year</div><div className="text-right">{fmtUSD(provVariableY,2)}</div>
                    <div className="text-slate-700">Total costs / year</div><div className="text-right font-medium">{fmtUSD(provVariableY + provFixedY,2)}</div>
                    <div className="text-slate-700">Operating margin / year</div><div className="text-right font-medium">{fmtUSD(provMarginY,2)} ({fmtNum(provMarginPct,1)}%)</div>
                    <div className="text-slate-500">Issuance credit / year</div><div className="text-right tabular-nums">{fmtNum(toAZTEC(provIssuanceY), 0)} AZTEC <span className="text-slate-400">({fmtUSD(provIssuanceY,2)})</span></div>
                    <div className="text-slate-700">Net margin incl issuance / year</div><div className="text-right font-medium">{fmtUSD(provMarginInclIssY,2)}</div>
                  </div>
                </div>
              </>
            );
          })()}
        </CardContent></Card>
      </div>
    </div>
  );
}


