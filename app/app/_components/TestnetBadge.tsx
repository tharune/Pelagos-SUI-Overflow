"use client";

import { C, FM } from "../_lib/tokens";

/**
 * Static network indicator — the app runs on Sui testnet. Replaces the old
 * in-UI faucet: getting test funds is not a user-facing action.
 */
export function TestnetBadge() {
  return (
    <span
      title="Running on Sui testnet"
      style={{
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "0 12px",
        borderRadius: 8,
        border: `0.5px solid ${C.border}`,
        background: C.surface,
        color: C.textSecondary,
        fontFamily: FM,
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: C.green,
          boxShadow: `0 0 6px ${C.green}`,
        }}
      />
      Testnet
    </span>
  );
}
