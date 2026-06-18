"use client";

/**
 * Interface-mode system for Pelagos — Basic vs Advanced.
 *
 * The whole product runs in two skins of the SAME underlying engine:
 *   • Basic    — clean, guided, prebuilt. The default for everyone.
 *   • Advanced — the institutional / tradfi-desk surface (orderbooks, 3D vol
 *                surface, custom basket builder, deployment detail).
 *
 * Mechanism mirrors the theme system:
 *   • A global React context exposes `{ mode, setMode, toggle }`.
 *   • `localStorage["pelagos.mode"]` persists the choice across reloads.
 *   • Initial SSR + first client render are ALWAYS "basic" so there is no
 *     hydration mismatch; a `useEffect` reconciles with stored preference on
 *     mount (one-frame flip for stored-Advanced users, no error).
 *
 * Usage:
 *   const { mode, toggle } = useMode();
 *   {mode === "advanced" ? <AdvancedView/> : <BasicView/>}
 *   <ModeToggle />   // the header segmented control
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { C, FD, FM, EASE } from "./tokens";

export type Mode = "basic" | "advanced";

const STORAGE_KEY = "pelagos.mode";

interface ModeContextValue {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggle: () => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  // Always start "basic" for SSR + the first client render so the server and
  // client trees match; reconcile with localStorage immediately after mount.
  const [mode, setModeState] = useState<Mode>("basic");

  useEffect(() => {
    let stored: Mode | null = null;
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === "basic" || v === "advanced") stored = v;
    } catch {
      /* ignore */
    }
    if (stored && stored !== "basic") {
      const id = window.setTimeout(() => setModeState(stored as Mode), 0);
      return () => window.clearTimeout(id);
    }
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: Mode = prev === "basic" ? "advanced" : "basic";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    // No-op fallback for any component rendered outside the provider.
    return { mode: "basic", setMode: () => {}, toggle: () => {} };
  }
  return ctx;
}

/**
 * Header segmented control: [ Basic | Advanced ].
 *
 * Sized to the 32px header chrome. The active segment fills with the brand
 * accent; the inactive one is muted. Reads as a deliberate, pro "view" switch,
 * not a settings checkbox.
 */
export function ModeToggle() {
  const { mode, setMode } = useMode();
  const segs: Array<{ key: Mode; label: string }> = [
    { key: "basic", label: "Basic" },
    { key: "advanced", label: "Advanced" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Interface mode"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        height: 32,
        padding: 2,
        borderRadius: 8,
        border: `0.5px solid ${C.border}`,
        background: C.surface,
      }}
    >
      {segs.map((s) => {
        const active = mode === s.key;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setMode(s.key)}
            title={s.key === "advanced" ? "Advanced — institutional desk view" : "Basic — clean guided view"}
            style={{
              appearance: "none",
              height: 26,
              padding: "0 11px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontFamily: FM,
              fontSize: 10.5,
              letterSpacing: "0.04em",
              fontWeight: active ? 600 : 500,
              color: active ? "#04121d" : C.textSecondary,
              background: active ? C.tealLight : "transparent",
              transition: `background 0.15s ${EASE}, color 0.15s ${EASE}`,
            }}
            onMouseEnter={(e) => {
              if (!active) (e.currentTarget as HTMLElement).style.color = C.textPrimary;
            }}
            onMouseLeave={(e) => {
              if (!active) (e.currentTarget as HTMLElement).style.color = C.textSecondary;
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Small "(Beta)" chip used next to product titles while these surfaces are
 * under active development.
 */
export function BetaTag({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 7px",
        borderRadius: 5,
        border: `0.5px solid ${C.tealLight}55`,
        background: `${C.tealLight}12`,
        color: C.tealLight,
        fontFamily: FM,
        fontSize: 9.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        fontWeight: 500,
        verticalAlign: "middle",
        ...style,
      }}
    >
      Beta
    </span>
  );
}
