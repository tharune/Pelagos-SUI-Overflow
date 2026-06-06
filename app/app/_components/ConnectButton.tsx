"use client";

import { ConnectButton as DappConnectButton } from "@mysten/dapp-kit";
import { C, FM } from "../_lib/tokens";

/**
 * Real Sui wallet connect (dapp-kit). Renders a "Connect Wallet" control that
 * opens the wallet picker and, once connected, shows the account + a dropdown.
 *
 * dapp-kit ships an oversized white "lg" pill for this (50px tall, 16px font,
 * white bg, 12px radius) which dwarfs the neighboring header controls. We scope
 * a style override to size + theme its trigger button to match the FaucetButton
 * (32px tall, 8px radius, surface bg, 11px mono). `.pelagos-connect
 * button[data-dapp-kit]` (specificity 0,2,1) outranks dapp-kit's single-class
 * vanilla-extract styles, and `!important` guards against future changes. The
 * dropdown menu renders in a portal outside this wrapper, so only the trigger
 * is restyled — the menu keeps dapp-kit's defaults.
 */
export function ConnectButton(_props: { variant?: "header" | "block" }) {
  return (
    <div className="pelagos-connect" style={{ display: "flex" }}>
      <style>{`
        .pelagos-connect button[data-dapp-kit] {
          height: 32px !important;
          min-height: 32px !important;
          padding: 0 12px !important;
          border-radius: 8px !important;
          background: ${C.surface} !important;
          color: ${C.textSecondary} !important;
          border: 0.5px solid ${C.border} !important;
          box-shadow: none !important;
          font-family: ${FM} !important;
          font-size: 11px !important;
          font-weight: 500 !important;
          letter-spacing: 0.02em !important;
          gap: 6px !important;
        }
        .pelagos-connect button[data-dapp-kit]:hover {
          color: ${C.textPrimary} !important;
          border-color: ${C.tealLight}55 !important;
        }
        .pelagos-connect button[data-dapp-kit] > div {
          font-family: ${FM} !important;
          font-size: 11px !important;
          font-weight: 500 !important;
          color: inherit !important;
        }
        .pelagos-connect button[data-dapp-kit] svg {
          color: inherit !important;
          opacity: 0.7;
        }
      `}</style>
      <DappConnectButton connectText="Connect Wallet" />
    </div>
  );
}
