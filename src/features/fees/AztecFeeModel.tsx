"use client";
import React, { useMemo, useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Info } from "lucide-react";
import { ResponsiveContainer, Tooltip, ComposedChart, Bar, XAxis, YAxis, Cell, LabelList } from "recharts";

const fmtUSD = (n: number, d = 6) => (isFinite(n) ? `$${n.toLocaleString(undefined, { maximumSignificantDigits: 2 })}` : "–");
const fmtUSDSig4 = (n: number) => (isFinite(n) ? n.toLocaleString(undefined, { maximumSignificantDigits: 4 }) : "–");
const fmtNum = (n: number, d = 0) => (isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "–");

interface NetworkParams { tps: number; blockTime: number; blocksPerEpoch: number; manaPerTx: number; bytesPerTxDA: number; bytesPerBlob: number; maxBlobsPerEthBlock: number; }
interface CostParams { ethPrice: number; l1GasPriceGwei: number; l1ExecGasPerBlock: number; blobGasPriceGwei: number; proofVerifyGasPerEpoch: number; proverComputeUSDPerTx: number; sequencerOverheadUSDPerTx: number; }
interface CongestionParams { minMultiplier: number; manaTarget: number; manaLimit: number; tipPctOfBase: number; proverShareOfUnburnedBase: number; blobsPerBlockPolicy: number; }
interface GovParams { maxSupplyTokens: number; circulatingPct: number; stakeRatePct: number; issuanceRateOnMaxPct: number; tokenPriceUSD: number; operatorIssuanceSeqSharePct: number; }

const DEFAULT: { net: NetworkParams; cost: CostParams; cong: CongestionParams; gov: GovParams } = {
  net: { tps: 10, blockTime: 12, blocksPerEpoch: 32*6, manaPerTx: 50_000, bytesPerTxDA: 1200, bytesPerBlob: 131_072, maxBlobsPerEthBlock: 6 },
  cost: { ethPrice: 4300, l1GasPriceGwei: 1, l1ExecGasPerBlock: 200_000, blobGasPriceGwei: 1, proofVerifyGasPerEpoch: 2_500_000, proverComputeUSDPerTx: 0.003, sequencerOverheadUSDPerTx: 0.0004 },
  cong: { minMultiplier: 1.1, manaTarget: 5_000_000, manaLimit: 10_000_000, tipPctOfBase: 10, proverShareOfUnburnedBase: 0.2, blobsPerBlockPolicy: 9 },
  gov: { maxSupplyTokens: 10_516_000_000, circulatingPct: 22.5, stakeRatePct: 60, issuanceRateOnMaxPct: 0.5, tokenPriceUSD: 2, operatorIssuanceSeqSharePct: 92.5 }
};

type StageName = "Ignition"|"Alpha"|"Beta";
const PRESETS: Record<StageName, { net: NetworkParams; cost: CostParams; cong: CongestionParams; gov: GovParams }> = {
  Alpha: { ...DEFAULT },
  Ignition: {
    net: { ...DEFAULT.net, tps: 0, blockTime: 72, blocksPerEpoch: 32 },
    cost: { ...DEFAULT.cost },
    cong: { ...DEFAULT.cong, minMultiplier: 1 },
    gov: { ...DEFAULT.gov, circulatingPct: 22.5, stakeRatePct: 80, issuanceRateOnMaxPct: 2, operatorIssuanceSeqSharePct: 92.5 }
  },
  Beta: {
    net: { ...DEFAULT.net, tps: 120, blockTime: 6, blocksPerEpoch: 64, maxBlobsPerEthBlock: 48 },
    cost: { ...DEFAULT.cost },
    cong: { ...DEFAULT.cong, manaTarget: 32_500_000, blobsPerBlockPolicy: 48 },
    gov: { ...DEFAULT.gov, circulatingPct: 90, operatorIssuanceSeqSharePct: 92.5 }
  }
};

function useModel(net: NetworkParams, cost: CostParams, cong: CongestionParams, gov: GovParams, proverPremiumPct: number) {
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
    const txPerBlockCapacity = Math.min(txPerBlockCapacity_mana, maxTxPerBlock_byBlob);
    const txPerBlock = Math.max(0, Math.min(txPerBlockDemand, txPerBlockCapacity));

    const epochTimeSec = net.blocksPerEpoch * net.blockTime;
    const blobsPerEpochUsed = blobsUsed * net.blocksPerEpoch;

    const verifyETHPerEpoch = cost.proofVerifyGasPerEpoch * gasPriceETH;
    const verifyETHPerBlock = verifyETHPerEpoch / Math.max(1, net.blocksPerEpoch);
    const proverOnchainUSDPerBlock_FIXED = verifyETHPerBlock * cost.ethPrice;

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
    const sequencerOverheadUSD_tx = cost.sequencerOverheadUSDPerTx;

    const seqRevenueUSD_tx = toSequencerPerManaUSD * net.manaPerTx + feeTipUSD_tx;
    const provRevenueUSD_tx = toProverPerManaUSD * net.manaPerTx;

    const seqFixedUSDPerBlock = seqExecUSDPerBlock_GAS_FIXED + proposalBlobUSDPerBlock_FIXED;
    const seqFixedUSDPerTx = seqFixedUSDPerBlock / Math.max(1, txPerBlock);

    const feesRetained_tx = feeBaseUSD_tx + feeTipUSD_tx - burnUSD_tx;
    const fundSeq = Math.min(sequencerETHCostPerTx, Math.max(0, feesRetained_tx));
    const fundProv = Math.min(proverETHCostPerTx, Math.max(0, feesRetained_tx - fundSeq));
    const passThroughFeesToETH_tx = fundSeq + fundProv;

    const seqNetUSD_tx = seqRevenueUSD_tx - (l1USDPerTx_DA + sequencerOverheadUSD_tx + seqFixedUSDPerTx);
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
    const issuanceToOperatorsUSDPerBlock = issuanceUSDPerBlock; // 100% to operators
    const issuanceToStakersUSDPerBlock = 0;
    const issuanceToSequencersUSDPerBlock = issuanceToOperatorsUSDPerBlock * (gov.operatorIssuanceSeqSharePct / 100);
    const issuanceToProversUSDPerBlock = issuanceToOperatorsUSDPerBlock - issuanceToSequencersUSDPerBlock;
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

    return { txPerBlockDemand, txPerBlockCapacity_mana, txPerBlockCapacity, txPerBlock, epochTimeSec, blocksPerDay, txPerDay, ETH_BLOCK_TIME,
      ethBlobBudgetPerL2Block_float, ethBlobBudgetPerL2Block,
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
      issuanceTokensPerYear, issuanceTokensPerBlock, issuanceUSDPerBlock, issuanceToOperatorsUSDPerBlock, issuanceToStakersUSDPerBlock, issuanceToSequencersUSDPerBlock, issuanceToProversUSDPerBlock, burnUSDPerBlock, netIssuanceAfterBurnUSDPerBlock,
      circTokens, stakedTokens, _stakerAPYPct, pureInflationUSDPerBlock, stakerRealAPYPct,
      toSequencerPerManaUSD, toProverPerManaUSD };
  }, [net, cost, cong, gov, proverPremiumPct]);
}

function NumberSlider({ label, min, max, step = 1, value, onChange, suffix, disabled = false }: { label: string; min: number; max: number; step?: number; value: number; onChange: (n: number) => void; suffix?: string; disabled?: boolean; }) {
  return (
    <div className={`space-y-2 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between"><Label className="text-sm text-slate-500">{label}</Label><span className="text-sm tabular-nums">{fmtNum(value, 6)}{suffix}</span></div>
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
  const [userWillingUSD, setUserWillingUSD] = useState<number>(0.1);
  const [seqSharePct, setSeqSharePct] = useState<number>(10);
  const [revMultiple, setRevMultiple] = useState<number>(12);
  const [oraclePremiumPct, setOraclePremiumPct] = useState<number>(0);
  const [stage, setStage] = useState<StageName>("Ignition");
  const [valuationUSD, setValuationUSD] = useState<number>(250_000_000);
  const [wfScale, setWfScale] = useState<'per_tx'|'per_block'|'per_epoch'|'per_day'|'per_month'|'per_year'|'pct_staked'|'pct_fdv'>("per_year");
  useEffect(()=>{
    const p = PRESETS[stage];
    setNet(p.net);
    setCost(p.cost);
    setCong(p.cong);
    setGov(p.gov);
    // Stage-specific default valuations
    if(stage === "Ignition") setValuationUSD(250_000_000);
    if(stage === "Alpha") setValuationUSD(500_000_000);
    if(stage === "Beta") setValuationUSD(1_000_000_000);
    // Stage-specific default user willingness to pay
    if(stage === "Alpha") setUserWillingUSD(0.10);
    if(stage === "Beta") setUserWillingUSD(0.05);
  },[stage]);
  // Derive token price from assumed FDV: price = FDV / max supply
  const govForModel: GovParams = gov.maxSupplyTokens > 0 ? { ...gov, tokenPriceUSD: valuationUSD / gov.maxSupplyTokens } : gov;
  const m = useModel(net, cost, cong, govForModel, oraclePremiumPct);

  // Intentionally omitting debug identity checks to satisfy lint rules

  const headroomUSD = Math.max(0, userWillingUSD - m.totalUserFeeUSD_tx);

  const share = seqSharePct / 100;
  const dailyTx = m.txPerDay * share;
  const seqDailyEBITDA = Math.max(0, m.seqNetUSD_tx * dailyTx);
  const seqAnnualEBITDA = seqDailyEBITDA * 365;
  const impliedOperatorValuation = seqAnnualEBITDA * revMultiple;

  const U = m.blockManaUsed;
  const feeB = m.baseFeePerManaUSD * U;
  const burnB = m.burnPerManaUSD * U;
  const tipsB = m.tipPerManaUSD * U;
  const seqCostB = m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE;
  const provCostB = m.proverOnchainUSDPerBlock_FIXED;

  const subsidyUSD_tx = m.proverSubsidyUSDPerBlock_FIXED / Math.max(1, m.txPerBlock);
  const nonETHCosts_tx = cost.sequencerOverheadUSDPerTx + cost.proverComputeUSDPerTx + subsidyUSD_tx;

  const seqNetPos_tx = Math.max(0, m.seqNetUSD_tx);
  const provNetPos_tx = Math.max(0, m.provNetUSD_tx);

  const paidToETH_block = (m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE) + m.proverOnchainUSDPerBlock_FIXED;
  const subsidy_block = m.proverSubsidyUSDPerBlock_FIXED;
  const inflation_block = m.issuanceToOperatorsUSDPerBlock;

  const seqFlow = stage === "Ignition"
    ? [
        { name: "Burned ETH (per block)", val: paidToETH_block, k: "eth" },
        { name: "Non‑ETH Subsidy (per block)", val: subsidy_block, k: "noneth" },
        { name: "Inflation to Operators (per block)", val: inflation_block, k: "infl" }
      ]
    : [
        { name: "Burn", val: m.burnUSD_tx, k: "burn" },
        { name: "Burned ETH", val: m.passThroughFeesToETH_tx, k: "eth" },
        { name: "Non‑ETH Costs (Seq+Prov)", val: nonETHCosts_tx, k: "noneth" },
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
      tip.eq = "inflation (per block) = issuanceToOperatorsUSDPerBlock";
      tip.sub = `= ${fmtUSD(m.issuanceToOperatorsUSDPerBlock,4)}`;
    } else if (k === "burn") {
      tip.eq = "burnUSD_tx = max(0, baseComponentPerManaUSD_BILLED × (congestionMultiplier − 1)) × manaPerTx";
      tip.sub = `= max(0, ${baseComp.toFixed(8)} × (${mult.toFixed(4)} − 1)) × ${fmtNum(mana,0)} = ${fmtUSD(m.burnUSD_tx,6)}`;
    } else if (k === "eth") {
      if(stage === "Ignition"){
        tip.eq = "Burned ETH (per block) = sequencer L1 per block + prover verify per block";
        tip.sub = `= ${fmtUSD((m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE),4)} + ${fmtUSD(m.proverOnchainUSDPerBlock_FIXED,4)}`;
      }else{
        tip.eq = "burnedETH_tx = min(seqCostPerTx, feesRetained) + min(provCostPerTx, max(0, feesRetained − min(seqCostPerTx, feesRetained)))";
        tip.sub = `seqCostPerTx=${fmtUSD(seqCostPerTx,6)}, provCostPerTx=${fmtUSD(provCostPerTx,6)}, feesRetained=${fmtUSD(feesRetained,6)} ⇒ ${fmtUSD(m.passThroughFeesToETH_tx,6)}`;
      }
    } else if (k === "noneth") {
      if(stage === "Ignition"){
        tip.eq = "Non‑ETH Subsidy (per block) = prover subsidy per block";
        tip.sub = `= ${fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,4)}`;
      }else{
        tip.eq = "nonETHCosts_tx = sequencerOverheadUSDPerTx + proverComputeUSDPerTx + subsidyPerBlock/txPerBlock";
        tip.sub = `${fmtUSD(cost.sequencerOverheadUSDPerTx,6)} + ${fmtUSD(cost.proverComputeUSDPerTx,6)} + ${fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,6)} / ${fmtNum(m.txPerBlock,2)} = ${fmtUSD(cost.sequencerOverheadUSDPerTx + cost.proverComputeUSDPerTx + (m.proverSubsidyUSDPerBlock_FIXED/Math.max(1,m.txPerBlock)),6)}`;
      }
    } else if (k === "prov") {
      tip.eq = "provNetUSD_tx = (baseComponentPerManaUSD_BILLED × proverShare × manaPerTx) − (l1USDPerTx_Verify + proverComputeUSD_tx)";
      tip.sub = `= (${baseComp.toFixed(8)} × ${(cong.proverShareOfUnburnedBase*100).toFixed(1)}% × ${fmtNum(mana,0)}) − (${fmtUSD(m.l1USDPerTx_Verify,6)} + ${fmtUSD(cost.proverComputeUSDPerTx,6)}) = ${fmtUSD(m.provNetUSD_tx,6)}`;
    } else if (k === "seq") {
      tip.eq = "seqNetUSD_tx = (baseComponentPerManaUSD_BILLED × (1 − proverShare) × manaPerTx + feeTipUSD_tx) − (l1USDPerTx_DA + sequencerOverheadUSD_tx + seqFixedUSDPerTx)";
      tip.sub = `= (${baseComp.toFixed(8)} × ${(100 - cong.proverShareOfUnburnedBase*100).toFixed(1)}% × ${fmtNum(mana,0)} + ${fmtUSD(m.feeTipUSD_tx,6)}) − (${fmtUSD(m.l1USDPerTx_DA,6)} + ${fmtUSD(cost.sequencerOverheadUSDPerTx,6)} + ${fmtUSD(m.seqFixedUSDPerTx,6)}) = ${fmtUSD(m.seqNetUSD_tx,6)}`;
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
      <Card className="shadow-sm xl:col-span-12"><CardHeader className="pb-3"><CardTitle>Per‑Transaction Breakdown (Income Statement)</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-slate-600">Network Stage</div>
          <select className="border rounded px-2 py-1 text-sm" value={stage} onChange={(e)=> setStage(e.target.value as any)}>
            <option>Ignition</option>
            <option>Alpha</option>
            <option>Beta</option>
          </select>
        </div>
        {stage !== "Ignition" && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-slate-600">Waterfall View</div>
            <select className="border rounded px-2 py-1 text-sm" value={wfScale} onChange={(e)=> setWfScale(e.target.value as any)}>
              <option value="per_tx">Per tx</option>
              <option value="per_block">Per block</option>
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
            <div className="text-slate-500">User Currently Pays</div><div className="text-right font-medium">{fmtUSD(m.totalUserFeeUSD_tx,6)}</div>
            <div className="text-slate-500">Network burns (congestion)</div><div className="text-right">{fmtUSD(m.burnUSD_tx,6)} ({fmtNum(pct(m.burnUSD_tx),2)}%)</div>
            <div className="text-slate-500">Burned ETHereum</div><div className="text-right">{fmtUSD(m.passThroughFeesToETH_tx,6)} ({fmtNum(pct(m.passThroughFeesToETH_tx),2)}%)</div>
            <div className="text-slate-500">Sequencers & Prover Non‑ETH Costs</div><div className="text-right">{fmtUSD(nonETHCosts_tx,6)} ({fmtNum(pct(nonETHCosts_tx),2)}%)</div>
            <div className="text-slate-500">Earned by Sequencers</div><div className="text-right">{fmtUSD(seqNetPos_tx,6)} ({fmtNum(pct(seqNetPos_tx),2)}%)</div>
            <div className="text-slate-500">Earned by Provers</div><div className="text-right">{fmtUSD(provNetPos_tx,6)} ({fmtNum(pct(provNetPos_tx),2)}%)</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-slate-500">Burned ETHereum (per block)</div><div className="text-right font-medium">{fmtUSD((m.seqExecUSDPerBlock_GAS_FIXED + m.proposalBlobUSDPerBlock_FIXED + m.seqBlobUSDPerBlock_VARIABLE + m.proverOnchainUSDPerBlock_FIXED),4)}</div>
            <div className="text-slate-500">Non‑ETH Subsidy (per block)</div><div className="text-right">{fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,4)}</div>
            <div className="text-slate-500">Inflation to Operators (per block)</div><div className="text-right">{fmtUSD(m.issuanceToOperatorsUSDPerBlock,4)}</div>
            <div className="text-slate-500">Net Issuance after Burn (per block)</div><div className="text-right">{fmtUSD(m.netIssuanceAfterBurnUSDPerBlock,4)}</div>
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
              { t: "Per block", mult: 1 },
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
                    <div className="text-right">{fmtUSD(perBlock_burn * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_paidETH * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_nonETH * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_provEarn * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_seqEarn * r.mult, 2)}</div>
                    <div className="text-right">{fmtUSD(perBlock_user * r.mult, 2)}</div>
                    <div className="text-right">{fmtNum(feesAPR,2)}% @ {fmtNum(gov.stakeRatePct,1)}%</div>
                    <div className="text-right">{fmtUSD(perBlock_issuance * r.mult, 2)}</div>
                  </React.Fragment>
                ))}
              </div>
            );
          })()}
        </div>
      </CardContent></Card>

      <div className="xl:col-span-5 space-y-6">
        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Assumptions</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label="Assumed FDV (USD)" min={50_000_000} max={2_000_000_000} step={5_000_000} value={valuationUSD} onChange={setValuationUSD} />
          <PercentSlider label="Staked Share of Circulating (%)" value={gov.stakeRatePct} onChange={(v)=> setGov({ ...gov, stakeRatePct: v })} />
          <PercentSlider label="Annual Issuance on Max Supply (%)" value={gov.issuanceRateOnMaxPct} onChange={(v)=> setGov({ ...gov, issuanceRateOnMaxPct: v })} />
          
          <PercentSlider label="Operator Issuance Share to Sequencers (%)" value={gov.operatorIssuanceSeqSharePct} onChange={(v)=> setGov({ ...gov, operatorIssuanceSeqSharePct: v })} />
        </CardContent></Card>
        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Configurable Utilisation</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label="User Demanded TPS" min={0} max={200} step={0.1} value={net.tps} onChange={(v) => setNet({ ...net, tps: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Block Time (s)" min={2} max={72} step={1} value={net.blockTime} onChange={(v) => setNet({ ...net, blockTime: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Blocks per Epoch" min={6} max={64} step={1} value={net.blocksPerEpoch} onChange={(v) => setNet({ ...net, blocksPerEpoch: v })} disabled={stage==="Ignition"} />
          <div className="pt-2 border-t" />
          <CardTitle className="text-base">Tx Details</CardTitle>
          <NumberSlider label="Tx Mana Cost (mana/tx)" min={5_000} max={2_000_000} step={1_000} value={net.manaPerTx} onChange={(v) => setNet({ ...net, manaPerTx: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Tx DA size (bytes)" min={200} max={200_000} step={50} value={net.bytesPerTxDA} onChange={(v) => setNet({ ...net, bytesPerTxDA: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="ETH Price (USD)" min={500} max={10000} step={10} value={cost.ethPrice} onChange={(v) => setCost({ ...cost, ethPrice: v })} />
          <NumberSlider label="L1 Gas Price (gwei)" min={0} max={50} step={0.1} value={cost.l1GasPriceGwei} onChange={(v) => setCost({ ...cost, l1GasPriceGwei: v })} />
          <NumberSlider label="L1 Blob Gas Price (gwei)" min={0} max={20} step={0.1} value={cost.blobGasPriceGwei} onChange={(v) => setCost({ ...cost, blobGasPriceGwei: v })} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Epoch Time</div><div className="text-right font-medium">{fmtNum(m.epochTimeSec, 0)} s</div><div className="text-slate-500">Tx / Block (demand / mana / DA)</div><div className="text-right">{fmtNum(m.txPerBlockDemand, 2)} / {fmtNum(m.txPerBlockCapacity_mana, 0)} / {fmtNum(m.maxTxPerBlock_byBlob, 0)}</div><div className="text-slate-500">Tx / Block (effective)</div><div className="text-right font-medium">{fmtNum(m.txPerBlock, 2)}</div><div className="text-slate-500">TPS limits (mana / DA)</div><div className="text-right">{fmtNum(m.tpsLimitByMana, 2)} / {fmtNum(m.tpsLimitByBlobs, 2)}</div></div>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Congestion & Burn Configuration</CardTitle></CardHeader><CardContent className="space-y-4">
          <NumberSlider label={`Policy: Blobs per L2 Block`} min={1} max={100} step={1} value={cong.blobsPerBlockPolicy} onChange={(v) => setCong({ ...cong, blobsPerBlockPolicy: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Minimum Congestion Multiplier" min={1} max={20} step={0.01} value={cong.minMultiplier} onChange={(v) => setCong({ ...cong, minMultiplier: v })} disabled={stage==="Ignition"} />
          <NumberSlider label="Mana Target per Block" min={5_000_000} max={200_000_000} step={250_000} value={cong.manaTarget} onChange={(v) => setCong({ ...cong, manaTarget: v, manaLimit: Math.max(v*2, cong.manaLimit) })} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Mana Limit per Block (2× target)</div><div className="text-right font-medium">{fmtNum(cong.manaTarget*2,0)}</div></div>
          <PercentSlider label="Tip as % of Base" value={cong.tipPctOfBase} onChange={(v) => setCong({ ...cong, tipPctOfBase: v })} disabled={stage==="Ignition"} />
          <PercentSlider label="Prover share of unburned base" value={cong.proverShareOfUnburnedBase * 100} onChange={(v) => setCong({ ...cong, proverShareOfUnburnedBase: v / 100 })} disabled={stage==="Ignition"} />
          <PercentSlider label="Prover Oracle Premium (%)" value={oraclePremiumPct} onChange={setOraclePremiumPct} disabled={stage==="Ignition"} />
          <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Min Fee</div><div className="text-right font-medium">{fmtUSD(m.baseFeePerManaUSD, 8)} / mana</div><div className="text-slate-500">Min Fee</div><div className="text-right">{fmtNum(m.baseFeePerManaGwei, 8)} gwei / mana</div><div className="text-slate-500">Mana per Gwei</div><div className="text-right">{fmtNum(m.manaPerGwei, 8)} mana / gwei</div></div>
        </CardContent></Card>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Operator Valuation (What‑if)</CardTitle></CardHeader><CardContent className="space-y-4"><NumberSlider label="Operator Share of Blocks (%)" min={0} max={100} step={1} value={seqSharePct} onChange={setSeqSharePct} /><NumberSlider label="Valuation Multiple (× EBITDA)" min={1} max={50} step={1} value={revMultiple} onChange={setRevMultiple} /><div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Daily Tx (share‑adjusted)</div><div className="text-right">{fmtNum(dailyTx,0)}</div><div className="text-slate-500">Sequencer EBITDA / day</div><div className="text-right font-medium">{fmtUSD(seqDailyEBITDA,2)}</div><div className="text-slate-500">Annualized EBITDA</div><div className="text-right font-medium">{fmtUSD(seqAnnualEBITDA,2)}</div><div className="text-slate-500">Implied Operator Valuation</div><div className="text-right font-semibold">{fmtUSD(impliedOperatorValuation,2)}</div></div></CardContent></Card>
      </div>

      <div className="xl:col-span-7 space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>L2 Cost per L1 Block – Sequencer</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="text-sm font-medium">Fixed</div>
            <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Exec Gas</div><div className="text-right">{fmtUSD(m.seqExecUSDPerBlock_GAS_FIXED,6)}</div><div className="text-slate-500">Proposal Blob (1×)</div><div className="text-right">{fmtUSD(m.proposalBlobUSDPerBlock_FIXED,6)}</div></div>
            <div className="text-sm font-medium">Variable</div>
            <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">DA Blobs (actual)</div><div className="text-right">{fmtUSD(m.seqBlobUSDPerBlock_VARIABLE,6)}</div><div className="text-slate-500">DA Blobs (charged)</div><div className="text-right">{fmtUSD(m.seqBlobUSDPerBlock_BILLED,6)}</div></div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500"><div>Inputs (Exec Gas)</div><div className="text-right">{fmtNum(cost.l1ExecGasPerBlock,0)} gas × {cost.l1GasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div><div>Inputs (Proposal Blob)</div><div className="text-right">1 × 2^17 × {cost.blobGasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div></div>
          </CardContent></Card>

          <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>L2 Cost per L1 Block – Prover</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="text-sm font-medium">Fixed</div>
            <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Verify (on-chain, per epoch)</div><div className="text-right">{fmtUSD(m.proverOnchainUSDPerBlock_FIXED,6)}</div><div className="text-slate-500">Subsidy (2× verifiers)</div><div className="text-right">{fmtUSD(m.proverSubsidyUSDPerBlock_FIXED,6)}</div></div>
            <div className="text-sm font-medium">Variable</div>
            <div className="grid grid-cols-2 gap-2 text-sm"><div className="text-slate-500">Oracle Premium</div><div className="text-right">{fmtNum(oraclePremiumPct,2)}%</div></div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500"><div>Inputs (Verify)</div><div className="text-right">{fmtNum(cost.proofVerifyGasPerEpoch,0)} gas × {cost.l1GasPriceGwei.toFixed(2)} gwei × ${fmtNum(cost.ethPrice,0)}</div></div>
          </CardContent></Card>
        </div>

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Blob usage as TPS rises</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-slate-500">ETH Budget / L2 Block</div><div className="text-right">{fmtNum(m.ethBlobBudgetPerL2Block, 0)}</div>
          <div className="text-slate-500">Policy Blobs / L2 Block</div><div className="text-right">{fmtNum(m.policyBlobCap, 0)}</div>
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
                  <div className="font-medium text-slate-700">Block Reward</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-500">- Sequencers</div><div className="text-right">{fmtUSD(perBlockSeq,4)}</div>
                    <div className="text-slate-500">- Provers</div><div className="text-right">{fmtUSD(perBlockProv,4)}</div>
                    <div className="text-slate-500">- Burnt</div><div className="text-right">{fmtUSD(perBlockBurn,4)}</div>
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

        <Card className="shadow-sm"><CardHeader className="pb-3"><CardTitle>Block Diagram</CardTitle></CardHeader><CardContent className="space-y-3">
          <BlockDiagram L={cong.manaTarget*2} T={cong.manaTarget} U={U} fee={feeB} burn={burnB} tips={tipsB} excess={m.excessMana} userPaysB={m.totalUserFeeUSD_tx*m.txPerBlock} right={{
            burnB: m.burnUSD_tx*m.txPerBlock,
            paidEthB: m.passThroughFeesToETH_tx*m.txPerBlock,
            nonEthB: (cost.sequencerOverheadUSDPerTx + cost.proverComputeUSDPerTx + (m.proverSubsidyUSDPerBlock_FIXED/Math.max(1,m.txPerBlock))) * m.txPerBlock,
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
            const seqOverheadY = cost.sequencerOverheadUSDPerTx * txPerYear;
            const seqVariableY = seqDaY + seqOverheadY;
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
                    <div className="text-slate-500">- Base share / year</div><div className="text-right">{fmtUSD(seqBaseShareY,2)}</div>
                    <div className="text-slate-500">- Tips / year</div><div className="text-right">{fmtUSD(seqTipsY,2)}</div>
                    <div className="text-slate-700">Total revenue / year</div><div className="text-right font-medium">{fmtUSD(seqRevenueY,2)}</div>
                    <div className="text-slate-600 pt-1">Costs</div><div className="pt-1"></div>
                    <div className="text-slate-500">- DA variable / year</div><div className="text-right">{fmtUSD(seqDaY,2)}</div>
                    <div className="text-slate-500">- Overhead / year</div><div className="text-right">{fmtUSD(seqOverheadY,2)}</div>
                    <div className="text-slate-500">- Fixed / year</div><div className="text-right">{fmtUSD(seqFixedY,2)}</div>
                    <div className="text-slate-700">Total costs / year</div><div className="text-right font-medium">{fmtUSD(seqVariableY + seqFixedY,2)}</div>
                    <div className="text-slate-700">Operating margin / year</div><div className="text-right font-medium">{fmtUSD(seqMarginY,2)} ({fmtNum(seqMarginPct,1)}%)</div>
                    <div className="text-slate-500">Issuance credit / year</div><div className="text-right">{fmtUSD(seqIssuanceY,2)}</div>
                    <div className="text-slate-700">Net margin incl issuance / year</div><div className="text-right font-medium">{fmtUSD(seqMarginInclIssY,2)}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="font-medium">Prover</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-slate-600">Revenue</div><div></div>
                    <div className="text-slate-500">- Base share / year</div><div className="text-right">{fmtUSD(provBaseShareY,2)}</div>
                    <div className="text-slate-700">Total revenue / year</div><div className="text-right font-medium">{fmtUSD(provRevenueY,2)}</div>
                    <div className="text-slate-600 pt-1">Costs</div><div className="pt-1"></div>
                    <div className="text-slate-500">- Verify (L1) / year</div><div className="text-right">{fmtUSD(provFixedY,2)}</div>
                    <div className="text-slate-500">- Compute / year</div><div className="text-right">{fmtUSD(provVariableY,2)}</div>
                    <div className="text-slate-700">Total costs / year</div><div className="text-right font-medium">{fmtUSD(provVariableY + provFixedY,2)}</div>
                    <div className="text-slate-700">Operating margin / year</div><div className="text-right font-medium">{fmtUSD(provMarginY,2)} ({fmtNum(provMarginPct,1)}%)</div>
                    <div className="text-slate-500">Issuance credit / year</div><div className="text-right">{fmtUSD(provIssuanceY,2)}</div>
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


