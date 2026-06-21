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
    '0x598434be38a69bf97b70490d320a698445990de38eb36e2f4c9d41dbe1ff3e45::mock_usdc::MOCK_USDC',
  usdcDecimals: Number(process.env.MOCK_USDC_DECIMALS ?? 6),
} as const;

/**
 * The SAME generic `Vault<T>` package, instantiated for DeepBook's `DUSDC` coin.
 * Lets the structured products settle in dUSDC with the identical deposit/redeem
 * mechanism as mUSDC (same package, same 6 decimals — only coin + object differ).
 */
export const VAULT_DUSDC = {
  vaultObjectId: process.env.VAULT_DUSDC_OBJECT_ID ?? '',
  adminCapId: process.env.VAULT_DUSDC_ADMIN_CAP_ID ?? '',
  usdcType:
    process.env.PREDICT_DUSDC_TYPE ??
    '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
  usdcDecimals: Number(process.env.DUSDC_DECIMALS ?? 6),
} as const;

export type VaultCurrency = 'mUSDC' | 'dUSDC';

/** Resolve the vault object + coin type for a settlement currency. */
export function resolveVault(currency?: VaultCurrency): {
  vaultObjectId: string;
  usdcType: string;
  usdcDecimals: number;
  label: VaultCurrency;
} {
  if (currency === 'dUSDC') {
    return {
      vaultObjectId: VAULT_DUSDC.vaultObjectId,
      usdcType: VAULT_DUSDC.usdcType,
      usdcDecimals: VAULT_DUSDC.usdcDecimals,
      label: 'dUSDC',
    };
  }
  return {
    vaultObjectId: VAULT.vaultObjectId,
    usdcType: VAULT.usdcType,
    usdcDecimals: VAULT.usdcDecimals,
    label: 'mUSDC',
  };
}

/** True once the vault package + shared object are configured. */
export function vaultConfigured(currency?: VaultCurrency): boolean {
  if (currency === 'dUSDC') return Boolean(VAULT.packageId && VAULT_DUSDC.vaultObjectId);
  return Boolean(VAULT.packageId && VAULT.vaultObjectId);
}

export function vaultTarget(fn: string): `${string}::${string}::${string}` {
  return `${VAULT.packageId}::vault::${fn}`;
}

/** Fully-qualified type of a deposit receipt for this vault's coin. */
export function shareType(): string {
  return `${VAULT.packageId}::vault::VaultShare<${VAULT.usdcType}>`;
}

/** Share-receipt type for an arbitrary coin instantiation of the vault. */
export function shareTypeFor(usdcType: string): string {
  return `${VAULT.packageId}::vault::VaultShare<${usdcType}>`;
}

export function explorerTx(digest: string): string {
  return `https://suiscan.xyz/${VAULT.network}/tx/${digest}`;
}
