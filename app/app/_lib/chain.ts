"use client";

export const CHAIN = (process.env.NEXT_PUBLIC_CHAIN ?? "sui").toLowerCase();
export const IS_SUI = CHAIN === "sui";

export const SUI_NETWORK = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";

// NOTE: the active wallet address always comes from the connected dapp-kit
// account (see wallet-bridge `useActiveWalletAddress`). There is intentionally
// no env/hardcoded address fallback — a disconnected app shows the connect state.

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

/**
 * Map a raw wallet/RPC signing error to a clear, actionable message.
 *
 * "Incorrect password" / "could not decrypt" come from the WALLET EXTENSION's
 * own lock screen (e.g. Slush), not from Pelagos — the dApp only ever requests
 * a signature, it never sees or checks your wallet password. Surfacing the bare
 * string ("Incorrect password") reads as if the app is wrong, so we translate
 * it into guidance: unlock the wallet itself, or reconnect if its session went
 * stale (auto-lock between actions is the usual trigger for the repeat prompts).
 */
export function friendlyWalletError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  let msg = raw;
  if (!msg) {
    try {
      msg = JSON.stringify(err) ?? "";
    } catch {
      msg = "";
    }
  }
  if (/user rejected|rejected the request|user cancel|rejection/i.test(msg)) {
    return "Transaction was rejected in your wallet.";
  }
  if (/insufficient/i.test(msg)) return msg;
  // Empty / opaque wallet error (e.g. the `{}` some wallets throw when they
  // can't process a transaction) or a lock/decrypt error. Give generic,
  // wallet-type-agnostic recovery guidance — works for seed-phrase, hardware,
  // and social/zkLogin wallets (which have no password to "get wrong").
  if (
    !msg ||
    msg === "{}" ||
    msg === "[object Object]" ||
    /incorrect password|could not decrypt|failed to decrypt|locked|sign/i.test(msg)
  ) {
    return "Your wallet couldn't sign the transaction. Try again — and if it persists, disconnect and reconnect your wallet (for a Google / social login, re-login to refresh the session). Make sure the wallet is on Sui testnet.";
  }
  return msg;
}
