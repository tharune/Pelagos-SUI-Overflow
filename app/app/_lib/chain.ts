"use client";

export const CHAIN = (process.env.NEXT_PUBLIC_CHAIN ?? "sui").toLowerCase();
export const IS_SUI = CHAIN === "sui";

export const SUI_NETWORK = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
export const SUI_ACTIVE_ADDRESS =
  process.env.NEXT_PUBLIC_SUI_ACTIVE_ADDRESS ?? "";

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// suiexplorer.com was sunset; Suiscan is the live explorer (matches the backend).
export function suiExplorerTxUrl(digest: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/tx/${digest}`;
}

export function suiExplorerObjectUrl(id: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/object/${id}`;
}
