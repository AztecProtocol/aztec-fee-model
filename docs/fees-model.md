Aztec Interactive Fee Model

Overview
This app explores how transaction fees evolve with throughput, L1 costs, policy, and oracle updates. It mirrors the structure of the draft design while making parameters adjustable to study different load regimes and willingness-to-pay.

Key references
- Design draft: https://github.com/AztecProtocol/engineering-designs/blob/main/in-progress/8757-fees/design.md

Model structure (high-level)
- Demand and capacity
  - txPerBlockDemand = tps × blockTime
  - Capacity limited by mana target/limit and blob data availability
- L1 costs
  - Sequencer: L1 exec gas (fixed), proposal blob (fixed), DA blobs (variable)
  - Prover: on-chain verification gas (fixed per epoch)
- Base fee components
  - Base component per mana = sequencer L1 per mana + prover verify per mana + prover compute per mana
  - Congestion multiplier grows with excess mana over target
  - Tips as a % of base
- Revenue split
  - Unburned base shared between sequencer and provers; burn covers a portion of L1 pass-through

What-if toggles
- User willingness to pay against the computed fee
- Operator share of blocks and EBITDA multiple for quick valuation sketches

Notes
- This is an exploratory tool, not financial advice. Parameters are intentionally exposed for sensitivity analysis.

