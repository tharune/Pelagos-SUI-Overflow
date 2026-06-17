"use client";

// ---------------------------------------------------------------------------
// Live markets depth — every active DeepBook Predict market (BTC expiries) with
// its forward, ATM implied vol, SVI skew, and binary up-probability, plus the
// PLP vault's live depth. All values are indexer-derived; nothing is fixed.
// ---------------------------------------------------------------------------

import React, { useEffect, useState } from "react";
import { C, FD, FM, FS } from "../_lib/tokens";
import { fetchMarkets, type MarketsDepth } from "../_lib/predict-strip-client";

const compact = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`;

const card: React.CSSProperties = { background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: 20 };

function VaultTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.surface, border: `0.5px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontFamily: FM, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>{label}</div>
      <div style={{ fontFamily: FD, fontSize: 18, fontWeight: 600, color: color ?? C.textPrimary, marginTop: 5 }}>{value}</div>
    </div>
  );
}

export function MarketsDepthPanel() {
  const [data, setData] = useState<MarketsDepth | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMarkets("BTC")
      .then((d) => {
        if (!alive) return;
        // Drop seconds-to-expiry markets — their SVI smile (skew/IV) is a T→0 artifact.
        const now = Date.now();
        setData({ ...d, markets: d.markets.filter((m) => m.expiry > now + 300_000) });
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontFamily: FM, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: C.textMuted }}>Live markets · BTC</div>
        <span style={{ fontFamily: FM, fontSize: 11, color: C.textMuted }}>{data ? `${data.markets.length} active oracles` : err ? "offline" : "loading…"}</span>
      </div>

      {data && (
        <>
          <div className="md-vault">
            <VaultTile label="PLP vault TVL" value={compact(data.vault.tvl_usd)} color={C.tealLight} />
            <VaultTile label="Share price" value={data.vault.share_price.toFixed(4)} color={C.green} />
            <VaultTile label="Utilization" value={`${(data.vault.utilization * 100).toFixed(2)}%`} />
            <VaultTile label="Max payout backed" value={compact(data.vault.total_max_payout_usd)} color={C.amber} />
          </div>

          <div style={{ marginTop: 14, display: "grid", gap: 5 }}>
            <div className="md-row md-row--head">
              <span>Tenor</span>
              <span style={{ textAlign: "right" }}>Forward</span>
              <span style={{ textAlign: "right" }}>ATM IV</span>
              <span style={{ textAlign: "right" }}>Skew</span>
              <span style={{ textAlign: "right" }}>P(up)</span>
              <span style={{ textAlign: "right" }}>Tick</span>
            </div>
            {data.markets.map((m) => (
              <div className="md-row" key={m.oracle_id}>
                <span style={{ color: C.textPrimary }}>{m.tenor_label}</span>
                <span style={{ textAlign: "right" }}>${m.forward_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                <span style={{ textAlign: "right", color: C.tealLight }}>{(m.atm_iv * 100).toFixed(0)}%</span>
                <span style={{ textAlign: "right", color: m.skew >= 0 ? C.green : C.red }}>{m.skew >= 0 ? "+" : ""}{(m.skew * 100).toFixed(1)}</span>
                <span style={{ textAlign: "right" }}>{(m.binary_up_atm * 100).toFixed(1)}%</span>
                <span style={{ textAlign: "right", color: C.textMuted }}>${m.tick_size_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
            ))}
          </div>
          <p style={{ fontFamily: FS, fontSize: 12, color: C.textMuted, margin: "12px 2px 0", lineHeight: 1.5 }}>
            Skew is the SVI put-minus-call vol (−10% vs +10% strikes), in vol points. P(up) is the protocol&apos;s binary
            up-probability at the forward. Every strip, tranche, note, and basket is priced off these live markets.
          </p>
        </>
      )}

      {!data && err && (
        <div style={{ fontFamily: FM, fontSize: 12, color: C.textMuted }}>Markets feed offline — start the backend.</div>
      )}

      <style jsx global>{`
        .md-vault { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
        @media (max-width: 720px) { .md-vault { grid-template-columns: repeat(2, 1fr); } }
        .md-row { display: grid; grid-template-columns: 1.1fr 1fr 0.7fr 0.7fr 0.8fr 0.9fr; gap: 8px; font-family: ${FM}; font-size: 11.5px; color: ${C.textSecondary}; padding: 3px 0; }
        .md-row--head { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${C.textMuted}; border-bottom: 0.5px solid ${C.border}; padding-bottom: 7px; }
      `}</style>
    </div>
  );
}
