"use client";
import dynamic from "next/dynamic";

const AztecFeeModel = dynamic(() => import("@/features/fees/AztecFeeModel"), { ssr: false });

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50">
      <AztecFeeModel />
    </main>
  );
}
