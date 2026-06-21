"use client";
/**
 * Shared chart + card primitives — orbital dark-space theme.
 */

import { C, FM, FS, FD } from "../_lib/tokens";

export function MetricTile({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div style={{
      background: C.cardGradient,
      border: `0.5px solid ${C.border}`,
      borderRadius: 14,
      padding: "18px 20px",
      position: "relative",
      overflow: "hidden",
      WebkitBackdropFilter: "blur(10px)",
      backdropFilter: "blur(10px)",
    }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1.5, background: `linear-gradient(to right, transparent, ${color || C.tealLight}66, transparent)`, opacity: 0.6 }} />
      <div style={{ position: "absolute", top: -40, right: -40, width: 120, height: 120, borderRadius: "50%", background: `radial-gradient(circle, ${color || C.tealLight}15 0%, transparent 65%)`, pointerEvents: "none" }} />
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: FM, letterSpacing: "0.14em", marginBottom: 10, position: "relative" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: color ?? C.textPrimary, fontFamily: FD, letterSpacing: "-0.01em", position: "relative" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 6, position: "relative" }}>{sub}</div>}
    </div>
  );
}
