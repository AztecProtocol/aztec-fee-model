"use client";
import * as React from "react";

interface SliderProps {
  value: number[];
  onValueChange: (val: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, disabled = false }: SliderProps) {
  const v = value?.[0] ?? 0;
  return (
    <input
      type="range"
      value={v}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onValueChange([Number(e.target.value)])}
      className={`w-full h-2 bg-slate-200 rounded-lg appearance-none accent-slate-800 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    />
  );
}


