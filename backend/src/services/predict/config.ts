import dotenv from 'dotenv';

dotenv.config();

/**
 * Current DeepBook Predict testnet deployment.
 *
 * Pinned to the `predict-testnet-4-16` branch of MystenLabs/deepbookv3.
 * Sources of truth:
 *   - packages/predict/README.md (package + object + quote asset)
 *   - https://predict-server.testnet.mystenlabs.com/config (quote asset allowlist)
 *
 * These move at mainnet launch; every value is overridable via env so configs
 * can be repointed without code changes.
 */
export const PREDICT = {
  network: process.env.PREDICT_NETWORK ?? 'testnet',
  rpcUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
  serverUrl:
    process.env.PREDICT_SERVER_URL ?? 'https://predict-server.testnet.mystenlabs.com',
  // Predict Move package (publishes `predict`, `predict_manager`, `market_key`, ...).
  packageId:
    process.env.PREDICT_PACKAGE_ID ??
    '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138',
  // The shared `Predict` protocol object (the market root).
  predictObjectId:
    process.env.PREDICT_OBJECT_ID ??
    '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
  // Enabled quote asset. NOT the regular testnet USDC.
  dusdcType:
    process.env.PREDICT_DUSDC_TYPE ??
    '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
  // Shared Clock object, fixed on every Sui network.
  clockId: '0x6',
  dusdcDecimals: 6,
} as const;

/** Build a fully-qualified Move call target against the current Predict package. */
export function predictTarget(
  module: string,
  fn: string,
): `${string}::${string}::${string}` {
  return `${PREDICT.packageId}::${module}::${fn}`;
}

/** Convenience snapshot of the active config (safe to expose over the API). */
export function predictConfig() {
  return {
    network: PREDICT.network,
    rpc_url: PREDICT.rpcUrl,
    server_url: PREDICT.serverUrl,
    package_id: PREDICT.packageId,
    predict_object_id: PREDICT.predictObjectId,
    dusdc_type: PREDICT.dusdcType,
    clock_id: PREDICT.clockId,
    dusdc_decimals: PREDICT.dusdcDecimals,
  };
}
