/**
 * Receipts / evidence — the "Brex-style" supporting-document layer.
 *
 * When a user sends a transaction (deposit, tranche buy, PPN open, distribution
 * launch) they can attach receipts or invoices that support it. Those files are
 * the audit trail: the Portfolio surfaces them as a per-position "Verification"
 * record.
 *
 * Storage is intentionally simple and dependency-light — each receipt is two
 * files on disk under `backend/uploads/`: the raw bytes (`<id>`) and a JSON
 * sidecar (`<id>.json`). No DB migration required; survives restarts.
 *
 *   POST /api/receipts            attach a file (base64 JSON body)
 *   GET  /api/receipts            list metadata, filterable by wallet/context
 *   GET  /api/receipts/:id        single metadata record
 *   GET  /api/receipts/:id/raw    stream the file inline (view / download)
 *   DELETE /api/receipts/:id      remove a receipt
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per file

// Receipts and invoices are images or PDFs. Keep the allowlist tight — it's both
// a safety boundary and an honesty boundary (we only render what we can show).
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
]);

export interface ReceiptMeta {
  id: string;
  wallet_address: string | null;
  context_type: string | null; // basket | tranche | ppn | distribution | deposit
  context_id: string | null; // bundle / position id the evidence supports
  digest: string | null; // optional on-chain tx digest
  filename: string;
  mime: string;
  size: number;
  memo: string | null;
  created_at: string; // ISO 8601
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function metaPath(id: string): string {
  return path.join(UPLOAD_DIR, `${id}.json`);
}
function blobPath(id: string): string {
  return path.join(UPLOAD_DIR, id);
}

async function readAllMeta(): Promise<ReceiptMeta[]> {
  await ensureDir();
  const entries = await fs.readdir(UPLOAD_DIR).catch(() => [] as string[]);
  const metas: ReceiptMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(UPLOAD_DIR, name), 'utf8');
      metas.push(JSON.parse(raw) as ReceiptMeta);
    } catch {
      /* skip unreadable sidecar */
    }
  }
  // Newest first.
  metas.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return metas;
}

/** Attach a receipt. Body carries the file as base64 plus light context. */
router.post('/', async (req: Request, res: Response) => {
  const {
    wallet_address,
    context_type,
    context_id,
    digest,
    filename,
    mime,
    memo,
    data_base64,
  } = req.body as {
    wallet_address?: string;
    context_type?: string;
    context_id?: string;
    digest?: string;
    filename?: string;
    mime?: string;
    memo?: string;
    data_base64?: string;
  };

  if (!data_base64 || typeof data_base64 !== 'string') {
    return res.status(400).json({ error: 'data_base64 is required' });
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }
  const cleanMime = (mime ?? '').toLowerCase();
  if (!ALLOWED_MIME.has(cleanMime)) {
    return res.status(400).json({
      error: `Unsupported file type "${mime}". Allowed: images (png/jpg/webp/gif/heic) or PDF.`,
    });
  }

  // Strip an optional data-URL prefix ("data:image/png;base64,...").
  const commaIdx = data_base64.indexOf(',');
  const b64 = data_base64.startsWith('data:') && commaIdx !== -1
    ? data_base64.slice(commaIdx + 1)
    : data_base64;

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'data_base64 is not valid base64' });
  }
  if (buf.length === 0) return res.status(400).json({ error: 'File is empty' });
  if (buf.length > MAX_BYTES) {
    return res
      .status(413)
      .json({ error: `File too large (${(buf.length / 1e6).toFixed(1)} MB). Max 8 MB.` });
  }

  const meta: ReceiptMeta = {
    id: randomUUID(),
    wallet_address: wallet_address ?? null,
    context_type: context_type ?? null,
    context_id: context_id ?? null,
    digest: digest ?? null,
    filename: filename.slice(0, 200),
    mime: cleanMime,
    size: buf.length,
    memo: memo ? memo.slice(0, 500) : null,
    created_at: new Date().toISOString(),
  };

  try {
    await ensureDir();
    await fs.writeFile(blobPath(meta.id), buf);
    await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {
    return res.status(500).json({ error: `Failed to store receipt: ${(err as Error).message}` });
  }

  res.status(201).json({ ...meta, url: `/api/receipts/${meta.id}/raw` });
});

/** List receipts, optionally filtered by wallet and/or context id. */
router.get('/', async (req: Request, res: Response) => {
  const wallet = (req.query.wallet as string | undefined)?.toLowerCase();
  const contextId = req.query.context_id as string | undefined;
  const contextType = req.query.context_type as string | undefined;
  try {
    let metas = await readAllMeta();
    if (wallet) metas = metas.filter((m) => m.wallet_address?.toLowerCase() === wallet);
    if (contextId) metas = metas.filter((m) => m.context_id === contextId);
    if (contextType) metas = metas.filter((m) => m.context_type === contextType);
    res.json({
      count: metas.length,
      receipts: metas.map((m) => ({ ...m, url: `/api/receipts/${m.id}/raw` })),
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to list receipts: ${(err as Error).message}` });
  }
});

/** Single metadata record. */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const raw = await fs.readFile(metaPath(req.params.id), 'utf8');
    const meta = JSON.parse(raw) as ReceiptMeta;
    res.json({ ...meta, url: `/api/receipts/${meta.id}/raw` });
  } catch {
    res.status(404).json({ error: 'Receipt not found' });
  }
});

/** Stream the file inline (for thumbnails, in-tab view, or download). */
router.get('/:id/raw', async (req: Request, res: Response) => {
  let meta: ReceiptMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath(req.params.id), 'utf8')) as ReceiptMeta;
  } catch {
    return res.status(404).json({ error: 'Receipt not found' });
  }
  try {
    const buf = await fs.readFile(blobPath(meta.id));
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${meta.filename.replace(/"/g, '')}"`,
    );
    res.send(buf);
  } catch {
    res.status(404).json({ error: 'Receipt file missing' });
  }
});

/** Remove a receipt (file + sidecar). */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await fs.unlink(metaPath(req.params.id)).catch(() => undefined);
    await fs.unlink(blobPath(req.params.id)).catch(() => undefined);
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete receipt: ${(err as Error).message}` });
  }
});

export const receiptRoutes = router;
