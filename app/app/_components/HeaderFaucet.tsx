"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { C, FD, FM, FS, EASE } from "../_lib/tokens";
import { useActiveWalletAddress, faucetTestFunds } from "../_lib/wallet-bridge";
import { suiExplorerTxUrl } from "../_lib/chain";

// What a single Mint hands out. Kept in sync with the backend dispenseTestFunds.
const GRANTS: Array<{ asset: string; amount: string; use: string; color: string }> = [
  { asset: "dUSDC", amount: "25", use: "Native DeepBook Predict quote asset", color: C.tealLight },
  { asset: "mUSDC", amount: "10,000", use: "Pelagos USDC — trade any product, 1:1 with dUSDC", color: C.blue },
  { asset: "SUI", amount: "0.05", use: "Gas, to sign your first transaction", color: C.violet },
];

/**
 * Header "Test funds" faucet. A small pill in the top bar opens a centered modal
 * that spells out exactly what will be sent (asset · amount · purpose), then one
 * Mint dispenses all three in a single operator transaction. The modal is
 * portalled to <body> so it centers on the viewport rather than inheriting the
 * header's blurred containing block. Testnet only.
 */
export function HeaderFaucet() {
  const address = useActiveWalletAddress();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ digest: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Lock body scroll + close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!address) return null;

  async function mint() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await faucetTestFunds(address);
      setDone({ digest: r.digest });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    window.setTimeout(() => {
      setDone(null);
      setErr(null);
    }, 200);
  }

  const modal = (
    <div
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(3,7,11,0.66)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "vfFade 0.16s ease-out",
      }}
    >
      <style>{`@keyframes vfFade{from{opacity:0}to{opacity:1}}@keyframes vfRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          borderRadius: 16,
          border: `0.5px solid ${C.border}`,
          background: C.card,
          boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
          padding: 24,
          animation: "vfRise 0.2s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: FM, fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: C.textMuted, marginBottom: 5 }}>
              Testnet faucet
            </div>
            <h3 style={{ fontFamily: FD, fontSize: 19, fontWeight: 640, color: C.textPrimary, margin: 0, letterSpacing: "-0.01em" }}>
              Get test funds
            </h3>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            style={{ appearance: "none", border: `0.5px solid ${C.border}`, borderRadius: 8, width: 28, height: 28, background: "transparent", color: C.textMuted, cursor: "pointer", fontSize: 13, lineHeight: 1, display: "grid", placeItems: "center" }}
          >
            ✕
          </button>
        </div>

        <p style={{ fontFamily: FS, fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, margin: "0 0 18px" }}>
          One transaction tops up your connected wallet with everything the app needs.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 11, overflow: "hidden", border: `0.5px solid ${C.border}`, marginBottom: 20 }}>
          {GRANTS.map((g, i) => (
            <div
              key={g.asset}
              style={{
                display: "grid",
                gridTemplateColumns: "108px 1fr",
                gap: 14,
                alignItems: "center",
                padding: "13px 15px",
                background: C.surface,
                borderTop: i === 0 ? "none" : `0.5px solid ${C.border}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontFamily: FD, fontSize: 17, fontWeight: 660, color: g.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>
                  {g.amount}
                </span>
                <span style={{ fontFamily: FM, fontSize: 10, fontWeight: 600, color: g.color, opacity: 0.8 }}>{g.asset}</span>
              </div>
              <span style={{ fontFamily: FS, fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>{g.use}</span>
            </div>
          ))}
        </div>

        {done ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ fontFamily: FM, fontSize: 12, color: C.green, lineHeight: 1.5, textAlign: "center" }}>
              ✓ Sent to your wallet ·{" "}
              <a href={suiExplorerTxUrl(done.digest)} target="_blank" rel="noreferrer" style={{ color: C.tealLight }}>
                {done.digest.slice(0, 10)}… ↗
              </a>
            </div>
            <button type="button" onClick={close} style={ghostBtn}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={mint}
            disabled={busy}
            style={{
              width: "100%",
              height: 46,
              borderRadius: 11,
              border: "none",
              cursor: busy ? "progress" : "pointer",
              fontFamily: FD,
              fontSize: 14,
              fontWeight: 630,
              color: "#03111d",
              background: C.tealLight,
              opacity: busy ? 0.65 : 1,
              transition: `opacity 0.15s ${EASE}`,
            }}
          >
            {busy ? "Minting…" : "Mint test funds"}
          </button>
        )}
        {err && <div style={{ marginTop: 12, fontFamily: FM, fontSize: 11, color: C.red, lineHeight: 1.5, textAlign: "center" }}>{err}</div>}
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Get testnet funds (dUSDC, mUSDC, SUI)"
        style={{
          appearance: "none",
          height: 32,
          padding: "0 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.tealLight}66`,
          background: `${C.tealLight}14`,
          color: C.tealLight,
          cursor: "pointer",
          fontFamily: FM,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.03em",
          whiteSpace: "nowrap",
          transition: `background 0.15s ${EASE}`,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = `${C.tealLight}22`)}
        onMouseLeave={(e) => (e.currentTarget.style.background = `${C.tealLight}14`)}
      >
        Test funds
      </button>
      {open && mounted ? createPortal(modal, document.body) : null}
    </>
  );
}

const ghostBtn: React.CSSProperties = {
  width: "100%",
  height: 42,
  borderRadius: 11,
  border: `0.5px solid ${C.border}`,
  background: "transparent",
  color: C.textPrimary,
  cursor: "pointer",
  fontFamily: FD,
  fontSize: 13,
  fontWeight: 600,
};
