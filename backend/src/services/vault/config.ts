/**
 * Config for the Pelagos on-chain vault (`pelagos_vault::vault`).
 *
 * Every value is env-overridable. The vault is a generic `Vault<T>`; Pelagos
 * instantiates it for the existing `MOCK_USDC` coin, so deposits/redemptions
 * are real Move calls returning real tx bytes — no fabricated object IDs.
 */
export const VAULT = {
  network: process.env.SUI_NETWORK ?? 'testnet',
  rpcUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
  packageId: process.env.VAULT_PACKAGE_ID ?? '',
  /** The shared `Vault<MOCK_USDC>` object. */
  vaultObjectId: process.env.VAULT_OBJECT_ID ?? '',
  /** `VaultAdminCap` held by the protocol signer (for fee withdrawal). */
  adminCapId: process.env.VAULT_ADMIN_CAP_ID ?? '',
  usdcType:
    process.env.MOCK_USDC_TYPE ??
    '0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC',
  usdcDecimals: Number(process.env.MOCK_USDC_DECIMALS ?? 6),
} as const;

/** True once the vault package + shared object are configured. */
export function vaultConfigured(): boolean {
  return Boolean(VAULT.packageId && VAULT.vaultObjectId);
}

export function vaultTarget(fn: string): `${string}::${string}::${string}` {
  return `${VAULT.packageId}::vault::${fn}`;
}

/** Fully-qualified type of a deposit receipt for this vault's coin. */
export function shareType(): string {
  return `${VAULT.packageId}::vault::VaultShare<${VAULT.usdcType}>`;
}

export function explorerTx(digest: string): string {
  return `https://suiscan.xyz/${VAULT.network}/tx/${digest}`;
}

export function explorerObject(id: string): string {
  return `https://suiscan.xyz/${VAULT.network}/object/${id}`;
}
