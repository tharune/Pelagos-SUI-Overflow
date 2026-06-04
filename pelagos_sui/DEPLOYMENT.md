# Pelagos Sui Testnet Deployment

This is the active Sui deployment for Pelagos-on-Sui. It includes a testnet-only
Mock USDC coin and a USDC-collateral binary prediction market.

Deployed from a wallet dedicated solely to Pelagos. It is deliberately separate
from every other project's wallet (no shared deployer, treasury caps, or test
funds), so there is no cross-contamination between deployments.

## Package

- Package ID: `0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af`
- Modules: `mock_usdc`, `prediction_market`
- Publish transaction: `AuA2G2Qtet7LrSTgrcPGPLZAojHiXVSLXgDyb9SSGaC6`
- Deployer / admin wallet: `0x78f0be0d03f277c11d696436a3dd2f02c02f9cce118f6c0286fbc701a29ec411` (alias `pelagos-deployer`)
- UpgradeCap: `0x56ffa7d79baedb7d3ed9b668b04e202fd6a4de258f9e4ee6cf23747a119c4c6c`
- Market AdminCap: `0x450d3450381a1f0fcbfbc0c354b8af4e7d0e7f732591bd6db57d5c14bf01105d`

## Mock USDC

- Coin type: `0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC`
- Symbol: `mUSDC`
- Decimals: `6`
- Metadata object (frozen): `0x952435fcae9412796ddf2a9f0e173c9a2caba7b2f26079714a9e1a3bfd33a287`
- TreasuryCap: `0x16b34adda0f968ab481449d55f445d3598e0a617f2d6a83d62e84907be534aa1`
- Initial mint: 100,000 mUSDC to the deployer wallet.

Mint authority is the owner of the TreasuryCap above (the deployer wallet).
Local credentials are referenced in `backend/.env.sui.local` via
`SUI_KEYSTORE_PATH` and `SUI_ACTIVE_ADDRESS`; never commit private keys.

## Smoke Test (this deployment, live on testnet)

A full mint → create market → buy round-trip was executed against the package:

- Market: `0xbfc6fec61ac51ff0282b6e9009ca9730f17ac79689fc7f9a4e12fa1065b49765`
- Position: `0xfb1580f4f0230bdb69823d7b8e75c2b06bf9cc46bf8eeb82e09aea2fb02b1cc5`
- Buy (YES, 10 mUSDC) transaction: `6uBojdRKv4shZgSWvvU5Q2KYvk5h1hTpkcXJj4jaE2Zv`
- Result: `yes_stake = 10000000`, `no_stake = 0`, `resolved = false`.

The Move unit suite passes (`sui move test --path pelagos_sui`, 2/2).
