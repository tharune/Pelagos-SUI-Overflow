# Pelagos — Live Testnet Deployment (2026-06-16)

Fresh from-scratch deployment under a dedicated wallet. Sui **testnet** (chain `4c78adac`).

## Deployer / operator wallet
- **Address:** `0xcad0f800f44a48360c01e9fa2d21e779bd829cb60e7220227ed16bb74d4d73e5`
- Key in `backend/.env` (`SUI_PRIVATE_KEY`, gitignored) + CLI keystore. Funded with testnet SUI.

## Pelagos packages (published this deploy)
| Thing | ID |
|---|---|
| `pelagos_sui` package (mock_usdc + prediction_market) | `0x598434be38a69bf97b70490d320a698445990de38eb36e2f4c9d41dbe1ff3e45` |
| `mock_usdc::Faucet` (shared, permissionless mint) | `0xd1f67a0ec1d4b26631fcd1810f16bbc0fdf88a83cfe04c26ad400566528a07f0` |
| `MOCK_USDC` type | `0x598434be…3e45::mock_usdc::MOCK_USDC` (6 dp) |
| `prediction_market::AdminCap` | `0x0c14a699335427625eb7317cd16e758f201b8a0413d58fd0592b20e761597c4b` |
| `pelagos_vault` package | `0xcaff49f849bdf83b2df754ffc7d43c07b19ee33c2395255185607b55802e2b19` |
| `Vault<MOCK_USDC>` (shared) — baskets / freely-testable | `0x5fdc7d7a94d1dc7ae459b2e3f6760cb3b6745e6c3e4f2eed511da54bd0042d2d` |
| `VaultAdminCap` (MOCK_USDC vault) | `0x177582ae9cb44b119835d224d4b8d2f14aac0157d41f0931b55ebef0f66ef348` |
| `Vault<dUSDC>` (shared) — Predict-backed PPN/tranche wrappers | `0x9110df6651807391a65f060a5c1fb0cfecf3163ecb11d879e1aa552f1868c54a` |
| `VaultAdminCap` (dUSDC vault) | `0xeecb761376a03d5d875846886905af59ebd418150666666102806e54fe7f843f` |

## DeepBook Predict (Mysten testnet — we call it, don't deploy it)
| Thing | ID |
|---|---|
| Predict package | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| Predict object (market root) | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| dUSDC type (Predict quote, faucet-gated) | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| Indexer | `https://predict-server.testnet.mystenlabs.com` |
| dUSDC faucet (manual) | https://tally.so/r/Xx102L |

## Collateral model
- **dUSDC** — the ONLY asset DeepBook Predict accepts. Used for every Predict leg (distribution range strips, PLP supply for the PPN floor, Predict-backed tranches). Faucet-gated.
- **MOCK_USDC** — freely mintable via the shared `Faucet` (`faucet`/`mint`, ≤1,000,000/call). Used for Pelagos's own contracts (Polymarket baskets, vault flows) so testing/demos are never bottlenecked. **Cannot** be a Predict quote (protocol AdminCap required to register a quote).

## Verified on-chain this deploy
- `pelagos_sui` + `pelagos_vault` published; both `sui move test` green (2/2 each).
- mock_usdc `faucet` minted 1,000,000 mUSDC (CLI) + backend service minted +12,345 (digest `Gi1JgvinJLRi2tGNfi9UQx6zH82AmXF9zriDmuVMyGh4`) → balance 1,012,345 mUSDC.
- `Vault<MOCK_USDC>` + `Vault<dUSDC>` created and shared.
- Predict range pricing + strip MM pricing/slippage verified live via devInspect (no funds).

## Live Predict E2E — VERIFIED on-chain (dUSDC granted 2026-06-16)
Operator manager: `0x7806a6636dd9764ec017134241fbff6d630e8fa7f594661489aeb6226596c166`
- `create_manager` ✅
- **mint range strip** (Distribution) ✅ digest `Jz37mnMGCMxrAdo4zAJbhvWoAJV8oeS3CHDkJPnw7Mz` (deposit dUSDC + N×mint_range in one PTB)
- **PLP supply** (PPN floor) ✅ digest `48LEWpyfHVtKyMcWjWxs2XXf5PEPEvbhVdLJjj4ZGT6k` → 9.98 PLP received
- **mint + redeem range** (sell side, both ways) ✅ digests `5iu38GUZantoDrp8mW4pS8K7x9kTvFpYhpmGfJjh2ck3` (mint), `cAZAWhRVUfLWPeUzuDPdp3qtHsLBvBuLBiDimTLCHZ3` (redeem)
- Indexer confirms: **4 range mints + 1 redeem**, PLP balance 9.98, wallet dUSDC 919 remaining.
- Pricing: real MM ask/bid + slippage from `get_(range_)trade_amounts`; mintable-band filter ([2%,98%]) keeps every surfaced bucket actually mintable (sub-1% bands abort `assert_mintable_ask`).

Remaining: seed larger pools when the 1M dUSDC grant lands; settlement/redeem_permissionless keeper.

## Full-flow re-verification (2026-06-19)
Every wallet-signed build dry-runs clean on-chain (operator as sender), and a fresh
real mint→redeem cycle confirms the live path on current code:
- create_manager ✅ · **strip/open (Distribution)** ✅ (~1.16 SUI gas, 8 bands) ·
  **vol/open (Volatility)** ✅ · **ppn/open (Protected Note)** ✅ · **lp/supply (PLP)** ✅ ·
  **termbasket/open (Calendar, 12 bands)** ✅ — all dry-run `success`.
- **REAL range mint** ✅ digest `61QFVhzFLoZ3BgcdaFmWz8Mmm2ZYXa5L8pHFoedx6d7P`
- **REAL range redeem** ✅ digest `ExPD5HRuos8U9bzsUGJHjqjErntmCFdfMt9UDbHdHxVz`
- Gas note: a 6–8 band Predict mint costs ~0.8–1.2 SUI; a 12-band term basket ~1.7 SUI.
  The connecting wallet (judge) pays its own gas — top it from the free Sui faucet.

## Judge / E2E testing — funding the operator
The whole product is **non-custodial**: the judge connects their OWN wallet and signs.
They need two assets:
- **SUI for gas** — free from `sui client faucet` / faucet.sui.io. Not a bottleneck.
- **dUSDC** — the ONLY asset DeepBook Predict settles in, and it is **faucet-gated**
  (its TreasuryCap is Mysten's — it cannot be minted like mUSDC).

So the app ships an **in-app dUSDC faucet**: every Predict surface (Distribution,
Volatility, PPN, Tranche, PLP) shows a **"Get test dUSDC"** button when the connected
wallet is short. It transfers a 25-dUSDC grant from the operator float
(`POST /api/dev/airdrop-dusdc`, operator-signed) so anyone can run the full flow without
the manual DeepBook form. Proven to a fresh wallet: digest `8hTzz3yvUmjACoTJLbX8EvDcsSdz3Nsbp9fxwEFssNh7`.

**To keep it topped up, send testnet funds to the operator:**
`0xcad0f800f44a48360c01e9fa2d21e779bd829cb60e7220227ed16bb74d4d73e5`
- **dUSDC** (the float the faucet hands out, ~25/grant): request to that address via
  https://tally.so/r/Xx102L. This is the one worth topping up for a judging session.
- **SUI** (operator dispenser/faucet gas, ~0.003/grant): a couple of SUI is plenty.
- mUSDC is freely minted on demand (vault/basket products), no top-up needed.
