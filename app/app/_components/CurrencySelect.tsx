"use client";

import React, { useEffect, useRef, useState } from "react";
import { C, FM, EASE } from "../_lib/tokens";

export type Currency = "dUSDC" | "mUSDC";

// Two equal USD settlement currencies (both $1), priced off the same DeepBook
// book. dUSDC is Predict's native quote asset; mUSDC is Pelagos-minted USDC.
const CURRENCY_NOTE: Record<Currency, string> = {
  dUSDC: "Native · DeepBook Predict",
  mUSDC: "Pelagos USDC · same DeepBook",
};

/**
 * Clean, custom collateral-currency dropdown (not a native <select>). Sits inside
 * a notional input as the unit suffix; click to switch between dUSDC and mUSDC.
 */
export function CurrencySelect({
  value,
  onChange,
  options = ["dUSDC", "mUSDC"],
}: {
  value: Currency;
  onChange: (c: Currency) => void;
  options?: Currency[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          padding: "0 7px",
          borderRadius: 7,
          border: `0.5px solid ${open ? C.tealLight + "88" : C.border}`,
          background: open ? `${C.tealLight}10` : C.surface,
          color: C.textSecondary,
          cursor: "pointer",
          fontFamily: FM,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
          transition: `border-color 0.14s ${EASE}, background 0.14s ${EASE}`,
        }}
      >
        {value}
        <svg width="8" height="5" viewBox="0 0 8 5" style={{ opacity: 0.7, transform: open ? "rotate(180deg)" : "none", transition: `transform 0.14s ${EASE}` }}>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 5px)",
            right: 0,
            zIndex: 40,
            minWidth: 188,
            padding: 4,
            borderRadius: 9,
            border: `0.5px solid ${C.border}`,
            background: C.card,
            boxShadow: "0 14px 34px rgba(0,0,0,0.4)",
            display: "grid",
            gap: 2,
          }}
        >
          {options.map((o) => {
            const active = o === value;
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                style={{
                  appearance: "none",
                  border: "none",
                  textAlign: "left",
                  borderRadius: 6,
                  padding: "7px 9px",
                  background: active ? `${C.tealLight}14` : "transparent",
                  color: active ? C.tealLight : C.textSecondary,
                  cursor: "pointer",
                  fontFamily: FM,
                  fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  transition: `background 0.12s ${EASE}`,
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = C.surface; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ display: "block" }}>{o}</span>
                {CURRENCY_NOTE[o] && (
                  <span style={{ display: "block", marginTop: 2, fontSize: 9, fontWeight: 400, lineHeight: 1.35, color: C.textMuted, letterSpacing: "0.01em" }}>
                    {CURRENCY_NOTE[o]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
