/**
 * Sui client and signer resolution for the Predict service. Lazily caches a
 * SuiJsonRpcClient (getSuiClient) and an Ed25519 signer (getSigner), resolved
 * from PREDICT_SIGNER_PRIVATE_KEY/SUI_PRIVATE_KEY or a Sui CLI keystore at
 * SUI_KEYSTORE_PATH (matched to SUI_ACTIVE_ADDRESS). signerAddress() returns the
 * signer's address or null so read-only/devInspect flows work with no key.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { PREDICT } from './config';

let cachedClient: SuiJsonRpcClient | null = null;

export function getSuiClient(): SuiJsonRpcClient {
  if (!cachedClient) {
    cachedClient = new SuiJsonRpcClient({
      url: PREDICT.rpcUrl,
      network: PREDICT.network as 'mainnet' | 'testnet' | 'devnet' | 'localnet',
    });
  }
  return cachedClient;
}

let cachedSigner: Ed25519Keypair | null = null;

function expandPath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/**
 * Load an Ed25519 keypair from the Sui CLI keystore.
 *
 * `SUI_KEYSTORE_PATH` may point either directly at a `sui.keystore` file or at
 * the enclosing `sui_config` directory. Each keystore entry is
 * base64(flag_byte || 32-byte secret); flag 0x00 == Ed25519.
 */
function loadFromKeystore(activeAddress?: string): Ed25519Keypair | null {
  const raw = process.env.SUI_KEYSTORE_PATH;
  if (!raw) return null;
  const expanded = expandPath(raw);
  const file = expanded.endsWith('.keystore')
    ? expanded
    : path.join(expanded, 'sui.keystore');
  if (!fs.existsSync(file)) return null;

  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  const want = activeAddress?.toLowerCase();
  let firstEd25519: Ed25519Keypair | null = null;

  for (const b64 of entries) {
    const bytes = fromBase64(b64);
    if (bytes.length !== 33 || bytes[0] !== 0x00) continue; // Ed25519 only
    const kp = Ed25519Keypair.fromSecretKey(bytes.slice(1));
    if (!firstEd25519) firstEd25519 = kp;
    if (want && kp.getPublicKey().toSuiAddress() === want) return kp;
  }

  // No active address requested (or it didn't match) -> first Ed25519 key.
  return want ? firstEd25519 : firstEd25519;
}

/**
 * Resolve the backend signing keypair.
 *
 * Resolution order:
 *   1. PREDICT_SIGNER_PRIVATE_KEY / SUI_PRIVATE_KEY (bech32 `suiprivkey...` or
 *      base64 of [flag||secret] or raw 32-byte secret)
 *   2. Sui CLI keystore at SUI_KEYSTORE_PATH, matched against SUI_ACTIVE_ADDRESS
 *
 * Read-only flows (server reads, devInspect previews) never call this, so the
 * integration is usable with no key configured.
 */
export function getSigner(): Ed25519Keypair {
  if (cachedSigner) return cachedSigner;

  const pk = process.env.PREDICT_SIGNER_PRIVATE_KEY ?? process.env.SUI_PRIVATE_KEY;
  if (pk) {
    if (pk.startsWith('suiprivkey')) {
      const { secretKey } = decodeSuiPrivateKey(pk.trim());
      cachedSigner = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      const bytes = fromBase64(pk.trim());
      cachedSigner = Ed25519Keypair.fromSecretKey(
        bytes.length === 33 ? bytes.slice(1) : bytes,
      );
    }
    return cachedSigner;
  }

  const fromStore = loadFromKeystore(process.env.SUI_ACTIVE_ADDRESS);
  if (fromStore) {
    cachedSigner = fromStore;
    return cachedSigner;
  }

  throw new Error(
    'No Predict signer configured. Set PREDICT_SIGNER_PRIVATE_KEY (suiprivkey... or base64), ' +
      'or SUI_KEYSTORE_PATH (+ optional SUI_ACTIVE_ADDRESS) pointing at your Sui CLI keystore.',
  );
}

/** Address of the configured signer, or null when no key is available. */
export function signerAddress(): string | null {
  try {
    return getSigner().getPublicKey().toSuiAddress();
  } catch {
    return null;
  }
}
