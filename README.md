Interactive fee model for Aztec Protocol (Ethereum L2), implemented as a Next.js app with Tailwind.

## Disclaimer

This dashboard is provided for **informational and illustrative purposes only**. It is a model and approximation of Aztec's economics, not an authoritative source. Values, formulas, and assumptions may be incomplete, out of date, or diverge from the deployed protocol. **Users must independently verify the correctness of any figures before relying on them.** Nothing here constitutes financial, investment, or operational advice. The Aztec Foundation accepts no responsibility or liability for any errors, omissions, discrepancies, or for any loss or decision made in reliance on this dashboard.

## Getting Started

1) Install deps
```bash
npm i
```
2) Run dev server
```bash
npm run dev
```
3) Open http://localhost:3000

## Model notes
- Based on Aztec fee design draft: [engineering-designs/8757-fees](https://github.com/AztecProtocol/engineering-designs/blob/main/in-progress/8757-fees/design.md).
- Sliders adjust throughput, congestion policy, L1 gas/blob prices, and oracle premium.

## Tech
- Next.js App Router, TypeScript, Tailwind
- Charts via `recharts`, icons via `lucide-react`
