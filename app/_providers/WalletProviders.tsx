"use client";

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit";

// Real Sui wallet stack: react-query → SuiClientProvider → WalletProvider.
// Non-custodial — deposits are built by the backend (/api/deposit/prepare) and
// signed by the user's connected wallet, never the server.
const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";
const { networkConfig } = createNetworkConfig({
  testnet: { url: process.env.NEXT_PUBLIC_SUI_RPC_URL ?? TESTNET_RPC, network: "testnet" },
});

const queryClient = new QueryClient();

export function WalletProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
