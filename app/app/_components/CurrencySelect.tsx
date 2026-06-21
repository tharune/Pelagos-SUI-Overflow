"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { C, FM, EASE } from "../_lib/tokens";

export type Currency = "dUSDC" | "mUSDC";

// Two equal USD settlement currencies (both $1), priced off the same DeepBook
// book. dUSDC is Predict's native quote asset; mUSDC is a freely-mintable demo
// token routed through the same engine.
const CURRENCY_NOTE: Record<Currency, string> = {
  dUSDC: "Native · DeepBook Predict",
  mUSDC: "Demo token · same engine",
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
  // Active descendant for keyboard navigation in the open listbox (roving
  // highlight): starts on the current value when the list opens.
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

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

  // When the list opens, seed the active option to the current value and move
  // keyboard focus into the listbox so Arrow/Enter/Escape are handled.
  useEffect(() => {
    if (!open) return;
    const i = options.indexOf(value);
    setActiveIdx(i >= 0 ? i : 0);
    listRef.current?.focus();
  }, [open, value, options]);

  // Keyboard handler for the open listbox: Arrow Up/Down move the highlight,
  // Enter/Space selects the highlighted option, Escape closes without changing.
  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[activeIdx];
      if (o) { onChange(o); setOpen(false); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
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
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label="Settlement currency"
          aria-activedescendant={`${listboxId}-opt-${activeIdx}`}
          onKeyDown={onListKeyDown}
          style={{
            outline: "none",
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
          {options.map((o, i) => {
            const active = o === value;
            const highlighted = i === activeIdx;
            return (
              <button
                key={o}
                id={`${listboxId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={-1}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                onMouseMove={() => setActiveIdx(i)}
                style={{
                  appearance: "none",
                  border: "none",
                  textAlign: "left",
                  borderRadius: 6,
                  padding: "7px 9px",
                  background: active ? `${C.tealLight}14` : highlighted ? C.surface : "transparent",
                  color: active ? C.tealLight : C.textSecondary,
                  cursor: "pointer",
                  fontFamily: FM,
                  fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  transition: `background 0.12s ${EASE}`,
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = C.surface; }}
                onMouseLeave={(e) => { if (!active && !highlighted) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
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
