/**
 * Receipts / evidence client — talks to the backend `/api/receipts` store.
 *
 * The "Brex-style" supporting-document layer: when a user sends a transaction
 * they can attach receipts or invoices. Those files persist server-side and the
 * Portfolio surfaces them as the position's verification / audit trail.
 */
import { BACKEND_URL } from "./tokens";

/** Receipt metadata as the app holds it (url is absolute, ready to render). */
export type EvidenceItem = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  memo: string | null;
  /** Absolute URL to stream the file inline (view / thumbnail / download). */
  url: string;
  createdAt: number;
};

export type EvidenceContext = {
  walletAddress?: string;
  contextType: string; // basket | tranche | ppn | distribution
  contextId: string; // bundle / position id the evidence supports
  digest?: string; // optional on-chain tx digest
};

/** Allowed upload types — mirrors the backend allowlist. */
export const ACCEPTED_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
];
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

type RawReceipt = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  memo: string | null;
  url: string; // relative
  created_at: string;
  context_type: string | null;
  context_id: string | null;
};

function toItem(r: RawReceipt): EvidenceItem {
  return {
    id: r.id,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    memo: r.memo,
    url: `${BACKEND_URL}${r.url}`,
    createdAt: Date.parse(r.created_at) || Date.now(),
  };
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => resolve(String(reader.result)); // data URL; backend strips prefix
    reader.readAsDataURL(file);
  });
}

/** Upload one file as evidence for a transaction. Returns the stored item. */
export async function uploadReceipt(
  file: File,
  ctx: EvidenceContext,
  memo?: string,
): Promise<EvidenceItem> {
  if (!ACCEPTED_MIME.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}`);
  }
  if (file.size > MAX_RECEIPT_BYTES) {
    throw new Error(`${file.name} is too large (max 8 MB)`);
  }
  const data_base64 = await readAsBase64(file);
  const res = await fetch(`${BACKEND_URL}/api/receipts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_address: ctx.walletAddress,
      context_type: ctx.contextType,
      context_id: ctx.contextId,
      digest: ctx.digest,
      filename: file.name,
      mime: file.type,
      memo: memo || null,
      data_base64,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Upload failed (${res.status})`);
  }
  return toItem((await res.json()) as RawReceipt);
}

/** Upload a batch; resolves to the stored items in input order. */
export async function uploadReceipts(
  files: File[],
  ctx: EvidenceContext,
  memo?: string,
): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];
  for (const f of files) out.push(await uploadReceipt(f, ctx, memo));
  return out;
}

/** Fetch stored receipts for a context (used to hydrate the audit trail). */
export async function fetchReceipts(params: {
  walletAddress?: string;
  contextId?: string;
  contextType?: string;
}): Promise<EvidenceItem[]> {
  const q = new URLSearchParams();
  if (params.walletAddress) q.set("wallet", params.walletAddress);
  if (params.contextId) q.set("context_id", params.contextId);
  if (params.contextType) q.set("context_type", params.contextType);
  const res = await fetch(`${BACKEND_URL}/api/receipts?${q.toString()}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { receipts: RawReceipt[] };
  return body.receipts.map(toItem);
}

/**
 * Fetch a wallet's receipts grouped by `${context_type}:${context_id}` — the
 * same key the sandbox uses — so the Portfolio audit trail survives reloads.
 */
export async function fetchEvidenceGrouped(
  walletAddress: string,
): Promise<Record<string, EvidenceItem[]>> {
  const q = new URLSearchParams({ wallet: walletAddress });
  const res = await fetch(`${BACKEND_URL}/api/receipts?${q.toString()}`);
  if (!res.ok) return {};
  const body = (await res.json()) as { receipts: RawReceipt[] };
  const grouped: Record<string, EvidenceItem[]> = {};
  for (const r of body.receipts) {
    if (!r.context_type || !r.context_id) continue;
    const key = `${r.context_type}:${r.context_id}`;
    (grouped[key] ??= []).push(toItem(r));
  }
  return grouped;
}

export async function deleteReceipt(id: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/receipts/${id}`, { method: "DELETE" }).catch(
    () => undefined,
  );
}

/** Human-readable byte size. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
