"use client";

import { ConnectButton as DappConnectButton } from "@mysten/dapp-kit";

/**
 * Real Sui wallet connect (dapp-kit). Renders a "Connect Wallet" control that
 * opens the wallet picker and, once connected, shows the account + a dropdown.
 */
export function ConnectButton(_props: { variant?: "header" | "block" }) {
  return <DappConnectButton connectText="Connect Wallet" />;
}
