# Pelagos Sui v2 Testnet Deployment

This is the active Sui deployment for local Pelagos-on-Sui work. It includes a
testnet-only Mock USDC coin and a USDC-collateral binary prediction market.

## Package

- Package ID: `0xd97616b19d16c944cb5f5f4d22c471df3d4ea1640764b46a2be2587a4be890cd`
- Modules: `mock_usdc`, `prediction_market`
- Publish transaction: `EbK3ZAQfLqcwVg9euXFHF6uACptHXKF4s1YHLXnB56VW`
- Deployer: `0xee770af6c184b101aa91fab0fffdee62c1fecc86fd3e681d978336bf70eead79`
- UpgradeCap: `0x85b7060ba87fd629493ba7ce657eea265f6270f795b4d8a7170613ac6f6a4aa3`

## Mock USDC

- Coin type: `0xd97616b19d16c944cb5f5f4d22c471df3d4ea1640764b46a2be2587a4be890cd::mock_usdc::MOCK_USDC`
- Symbol: `mUSDC`
- Decimals: `6`
- Metadata object: `0x11c140299db5f040b3dc3ea5d65d58ae145c51f445c71274a9f7172c0274d4ee`
- TreasuryCap: `0x190323bf43fb743f3ccf153ebbb978acfb3a86b5c60643228a1a2f4d0445b5c7`
- Initial mint transaction: `NT3dCkpAZsNRLPD53KKsc6m9cwVJ26Km8rLgqjQQns8`
- Initial minted coin: `0x6b811574ea87a94881207a2cde4aaabb58bf9eacb98fc8516fc9a9c1d116fe9f`

Mint authority is the owner of the TreasuryCap above. Local credentials are
referenced in `backend/.env.sui.local` via `SUI_KEYSTORE_PATH` and
`SUI_ACTIVE_ADDRESS`.

## Backend Smoke Test

The local backend is wired to this deployment through `backend/.env.sui.local`
and should report the package, AdminCap, TreasuryCap, and Pelagos mUSDC balance
from `http://localhost:13101/api/sui/status`.

Small backend write smoke test executed through
`POST http://localhost:13101/api/sui/local/basket/deposit`.

- Bundle: `smoke-pelagos-redeploy`
- Market: `0x7963cd9cbc758f6f9368757c7c8740734cc9456f6fae26a569d0860e89c6c245`
- Position: `0xc703cd54877471d85474bdad73c103a313078a5d0277aebd81e596f8399f962d`
- Mint transaction: `EjuUPuexE6wZbzB7t66fuoQdzeicdQLdo7FD8JqKTFzS`
- Create market transaction: `ADoLxCVYDnWJUb384YYQKTN9DbNffieayRhEdFbTzv8i`
- Buy transaction: `CBWjnvuLo7BndFXF1HP8xarof97tnSBMupucFA55nKAx`
