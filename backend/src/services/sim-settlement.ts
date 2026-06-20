/**
 * mUSDC simulation settlement — an INDEPENDENT settlement venue, fully decoupled
 * from dUSDC / Mysten DeepBook Predict.
 *
 * dUSDC settles structured products on the real Predict order book (faucet-gated,
 * scarce). mUSDC is OUR freely-mintable currency (`mock_usdc`, a shared faucet we
 * control) used to simulate the same products in perpetuity. There is NO swap or
 * peg between the two — they are two separate rails on the same priced product.
 *
 * Mechanism (real on-chain, infinite supply, we control the payout):
 *   • OPEN  — the user deposits the premium into our generic `Vault<MOCK_USDC>`
 *             (real `vault::deposit`, a transferable `Vaultshare` receipt tagged
 *             with a `sim:<product>:<id>` label). The premium becomes house float.
 *   • SETTLE— the protocol computes the realized payoff from the recorded position
 *             economics + the live settlement forward, and mints exactly that much
 *             mUSDC to the holder (`mock_usdc::mint`). The share is NOT redeemed,
 *             so net P&L = payoff − premium models BOTH wins and losses correctly.
 *
 * Honest framing: mUSDC = "simulation with real on-chain custody + receipts," not
 * real Predict settlement. The UI labels it as such.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { prepareDeposit, type PreparedTx } from './vault/index';
import { mintMockUsdc } from './mock-usdc';
import { predictServer } from './predict/server';

export type SimProduct = 'strip' | 'option' | 'vol' | 'dist';

export interface SimBand {
  lower_usd: number;
  higher_usd: number;
  payout_usd: number; // realized payout if settlement lands in this band
}

export interface SimPosition {
  sim_id: string;
  owner: string;
  product: SimProduct;
  label: string;
  name: string;
  premium_usd: number;
  max_payout_usd: number;
  oracle_id: string | null;
  forward_usd: number; // forward at open (fallback settlement basis)
  expiry_ms: number | null;
  bands: SimBand[];
  status: 'pending' | 'open' | 'settled';
  open_digest: string | null;
  settle_digest: string | null;
  payoff_usd: number | null;
  opened_at: number;
}

// ---- store (in-memory + JSON persistence so positions survive a dev restart) --
const STORE_FILE = path.resolve(process.cwd(), '.sim-positions.json');
const positions = new Map<string, SimPosition>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const arr = JSON.parse(raw) as SimPosition[];
    for (const p of arr) positions.set(p.sim_id, p);
  } catch {
    /* fresh store */
  }
}
async function persist(): Promise<void> {
  try {
    await fs.writeFile(STORE_FILE, JSON.stringify([...positions.values()], null, 0));
  } catch {
    /* best-effort; in-memory remains authoritative this session */
  }
}

let counter = 0;
function newSimId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

// ---- open ---------------------------------------------------------------------
export interface SimOpenArgs {
  owner: string;
  product: SimProduct;
  name: string;
  premium_usd: number;
  max_payout_usd: number;
  oracle_id?: string | null;
  forward_usd: number;
  expiry_ms?: number | null;
  bands: SimBand[];
}

/** Build the user-signed mUSDC deposit (premium → Vault<MOCK_USDC>, labelled). */
export async function prepareSimOpen(
  args: SimOpenArgs,
): Promise<PreparedTx & { sim_id: string; label: string }> {
  await load();
  if (!(args.premium_usd > 0)) throw new Error('premium_usd must be positive');
  const simId = newSimId();
  const label = `sim:${args.product}:${simId}`;
  const pos: SimPosition = {
    sim_id: simId,
    owner: args.owner,
    product: args.product,
    label,
    name: args.name,
    premium_usd: args.premium_usd,
    max_payout_usd: args.max_payout_usd,
    oracle_id: args.oracle_id ?? null,
    forward_usd: args.forward_usd,
    expiry_ms: args.expiry_ms ?? null,
    bands: args.bands ?? [],
    status: 'pending',
    open_digest: null,
    settle_digest: null,
    payoff_usd: null,
    opened_at: Date.now(),
  };
  const prepared = await prepareDeposit({ owner: args.owner, amount_usdc: args.premium_usd, label });
  positions.set(simId, pos);
  await persist();
  return { ...prepared, sim_id: simId, label };
}

/** Mark a sim position opened once the user's deposit confirms. */
export async function confirmSimOpen(simId: string, digest: string): Promise<SimPosition> {
  await load();
  const pos = positions.get(simId);
  if (!pos) throw new Error(`unknown sim position ${simId}`);
  pos.status = 'open';
  pos.open_digest = digest;
  await persist();
  return pos;
}

// ---- settle -------------------------------------------------------------------
/** Settlement basis = the oracle's realized `settlement_price` once it has settled,
 *  otherwise the forward recorded at open (mark-to-open). */
async function settlementForward(pos: SimPosition): Promise<number> {
  if (!pos.oracle_id) return pos.forward_usd;
  try {
    const oracles = await predictServer.predictOracles().catch(() => predictServer.oracles());
    const o = oracles.find((x) => x.oracle_id === pos.oracle_id);
    if (o && o.settlement_price != null) {
      const px = Number(o.settlement_price) / 1e9;
      if (Number.isFinite(px) && px > 0) return px;
    }
  } catch {
    /* fall back */
  }
  return pos.forward_usd;
}

/** Realized payoff = the single band the settlement forward lands in (settlement
 *  resolves to exactly one band; if outside every band, the structure expires
 *  worthless). */
function realizedPayoff(pos: SimPosition, fwd: number): number {
  for (const b of pos.bands) {
    if (fwd >= b.lower_usd && fwd < b.higher_usd) return Math.max(0, b.payout_usd);
  }
  return 0;
}

export interface SimSettleResult {
  sim_id: string;
  settlement_forward_usd: number;
  payoff_usd: number;
  premium_usd: number;
  pnl_usd: number;
  mint_digest: string | null;
  explorer_url: string | null;
}

/** Compute the payoff and mint exactly that much mUSDC to the holder. */
export async function settleSim(simId: string): Promise<SimSettleResult> {
  await load();
  const pos = positions.get(simId);
  if (!pos) throw new Error(`unknown sim position ${simId}`);
  // Idempotent: never re-mint an already-settled position (a double-settle would
  // pay the holder twice). Replay the booked result instead.
  if (pos.status === 'settled') {
    return {
      sim_id: simId,
      settlement_forward_usd: pos.forward_usd,
      payoff_usd: pos.payoff_usd ?? 0,
      premium_usd: pos.premium_usd,
      pnl_usd: (pos.payoff_usd ?? 0) - pos.premium_usd,
      mint_digest: pos.settle_digest ?? null,
      explorer_url: null,
    };
  }
  const fwd = await settlementForward(pos);
  // Cap at max payout, floor at 0, and never let a non-finite value reach the mint.
  const cap = Number.isFinite(pos.max_payout_usd) ? pos.max_payout_usd : realizedPayoff(pos, fwd);
  const payoff = Math.max(0, Math.min(realizedPayoff(pos, fwd), cap));
  if (!Number.isFinite(payoff)) throw new Error(`settlement produced a non-finite payoff for ${simId}`);
  let mintDigest: string | null = null;
  let explorer: string | null = null;
  if (payoff > 0) {
    const r = await mintMockUsdc(pos.owner, payoff);
    mintDigest = r.digest;
    explorer = r.explorer_url;
  }
  pos.status = 'settled';
  pos.payoff_usd = payoff;
  pos.settle_digest = mintDigest;
  await persist();
  return {
    sim_id: simId,
    settlement_forward_usd: fwd,
    payoff_usd: payoff,
    premium_usd: pos.premium_usd,
    pnl_usd: payoff - pos.premium_usd,
    mint_digest: mintDigest,
    explorer_url: explorer,
  };
}

export async function listSimPositions(owner: string): Promise<SimPosition[]> {
  await load();
  return [...positions.values()]
    .filter((p) => p.owner.toLowerCase() === owner.toLowerCase())
    .sort((a, b) => b.opened_at - a.opened_at);
}
