Interactive fee model for Aztec Protocol (Ethereum L2), implemented as a Next.js app with Tailwind.

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
