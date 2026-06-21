"use client";

// ---------------------------------------------------------------------------
// Protected Notes — principal-protected structured notes: a floor sleeve (PLP /
// vault) preserves principal while the yield budget funds an upside DeepBook
// strip. Settles in dUSDC (Predict rail) or mUSDC (our Vault sim rail).
// ---------------------------------------------------------------------------

import { Header, PageFrame } from "../_components/Header";
import { useWalletSigner } from "../_lib/wallet-bridge";
import { PpnPanel, PageHead, StripStyles } from "../_components/strip-products";

export default function PpnPage() {
  const wallet = useWalletSigner();

  return (
    <>
      <Header />
      <PageFrame wide>
        <PageHead
          eyebrow="BTC · Protected Notes"
          title="Protected Notes"
          sub={
            <>
              Your floor earns itself back in the PLP house pool; the rest buys an upside BTC range strip — one signed
              transaction, principal protected.
            </>
          }
        />
        <PpnPanel wallet={wallet} />
      </PageFrame>
      <StripStyles />
    </>
  );
}
