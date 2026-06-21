# HANDOFF — read this first

Pelagos: a Sui-testnet structured-products dApp on DeepBook Predict. Forked Next.js
16 frontend + Express/tsx backend. This doc is the fast-orient for a fresh session.
For depth: `README.md`, `ARCHITECTURE.md`, `README_DEEPBOOK.md`, `DEPLOYMENT.md`.

_Last updated: 2026-06-21. Tree is clean and pushed to `sui/main`._

---

## ⚠️ ACTIVE PARALLEL WORK — pull before you touch anything
A teammate (**Victor** `victorrs0215@gmail.com`) is pushing to `sui/main` at the same
time (landing, portfolio, and strategy-grid commits). **Always `git pull --rebase sui
main` before starting**, and rebase + re-verify before each push. As of this writing
the agent's work (mUSDC default, basic-3 strategies, vol surface, clean copy, dead-nav
removal) is all merged and intact in the tree, and the merged tree is FE+BE `tsc`-clean.

## State right now
- **Deploy-ready** as of the last full check: frontend `next build` ✓, backend `tsc` ✓.
  After pulling Victor's latest, **re-run `npm run build` once** before deploying.
- Working tree clean, everything pushed to remote **`sui`**, branch **`main`**.
- Dev servers were left running: frontend `:13100`, backend `:13101` (monitor `:13102`).

## Run it
```bash
# backend (tsx watch)         -> http://localhost:13101
cd backend && npm run dev
# frontend (next dev)         -> http://localhost:13100   (run from repo ROOT)
npm run dev
# production build checks
npm run build            # frontend (next build)
cd backend && npm run build   # backend (tsc -> dist)
```

## Routing gotcha (not standard Next)
- Marketing landing is at **`/`** → `app/page.tsx`.
- The app lives under **`/app/*`** → router dir is `app/app/`. e.g. `/app/deepbook`,
  `/app/volatility`, `/app/portfolio`, `/app/basket/[id]`.
- `/app` (bare) redirects to `/app/portfolio`.
- `AGENTS.md` warns this is a **modified Next.js** — read `node_modules/next/dist/docs/`
  before writing Next code; conventions may differ from training data.

## The mental model: two settlement rails
Every trade surface has a currency selector. **mUSDC is now the DEFAULT everywhere.**
- **mUSDC** (default) — our `Vault<MOCK_USDC>` "sim" rail. Real on-chain (deposit the
  premium → mint the payoff at settlement), **~$0.003 gas**, small tx that builds
  instantly in the wallet, reliable. Settles "Sui · Pelagos USDC vault".
- **dUSDC** (opt-in) — real **DeepBook Predict**. Heavier: each leg mints an on-chain
  RangePosition object, so 6–8 legs ≈ a big tx (slow wallet build, ~0.5+ SUI budget,
  can fail if the manager/dUSDC isn't funded). Settles "Sui · DeepBook Predict".
- The 6–8 legs are preserved on both rails — on mUSDC they're just payoff bands, not
  8 on-chain objects, which is why it's cheap.

## Decisions locked this session (don't re-litigate)
- **Default rail = mUSDC** (user's call). dUSDC stays one click away.
- **Baskets stays** (user's call) — it's still priced off live Polymarket under the
  hood, but the **user-facing copy was cleaned** ("live order book", not "Polymarket
  CLOB"). Internal code comments that truthfully describe the Polymarket-backed code
  were left accurate. Do NOT delete the Baskets/Polymarket plumbing.
- Volatility Advanced desk **defaults to the Payoff tab**, never the 3D surface.
- Basic mode shows a **curated 3** strategies + 3 notes; Advanced shows the full set.

## Open / next up (morning)
1. **Task 59 — dUSDC opt-in submit failure (needs a LIVE repro).** The default (mUSDC)
   path is cheap/instant/reliable. To fix dUSDC: on `/app/deepbook` switch the currency
   to **dUSDC**, deploy, and capture the **wallet + browser-console error**. Likely
   manager/dUSDC funding or an object-version race. Can't be reproduced headlessly.
2. **Task 60 (optional, careful) — orphan routes.** `/app/ppn` and `/app/tranche` are
   not in the nav but still build and are deep-link-reachable; the **portfolio reads
   PPN data** (`app/app/_lib/ppn-client.ts`, `ppn-hydrate.ts`). Left in deliberately —
   only delete with build + boot verification.
3. Optional perf: dUSDC prepare could cache `previewStrip` longer (RANGE_BATCH_TTL_MS
   in `backend/src/services/predict/index.ts`) — skipped to avoid quote staleness.

## Conventions (IMPORTANT)
- **Commits:** author `Tharun Ekambaram <tharun.ekam@gmail.com>`, **`--no-gpg-sign`**,
  and **NO AI attribution** (no Co-Authored-By / "Generated with"). Push to `sui main`.
- **Render QA:** drive headless Chrome and read the PNG. WebGL (the 3D vol surface)
  needs software GL:
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
    --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
    --virtual-time-budget=11000 --window-size=1500,1700 \
    --screenshot=/tmp/out.png "http://127.0.0.1:13100/app/volatility?mode=advanced"
  ```
  Mode deep-link: `?mode=advanced` / `?mode=basic` (also `localStorage["pelagos.mode"]`).

## Env / credentials
- Active config: **`backend/.env`** (full, has secrets) + repo-root **`.env.local`**
  (frontend). The `*.sui.local` files are **stale partials** — ignore them.
- Backend signs from **`SUI_PRIVATE_KEY`** (no `sui` CLI keystore needed); operator/
  faucet/signer wallet is **`0x450d3450…105d`** (~1 SUI). `ANTHROPIC_API_KEY` is empty.
- A consolidated teammate-handoff env was generated at **`~/Desktop/pelagos-handoff.env`**
  (outside the repo, perms 600). All `.env*` are git-ignored — never commit secrets.

## Key files
- Landing: `app/page.tsx`
- DeepBook strategies + Protected Notes: `app/app/deepbook/page.tsx`
- Volatility desk: `app/app/volatility/page.tsx`; 3D surface `…/volatility/_components/VolSurface3D.tsx`
- Distribution / options chain: `app/app/distribution/page.tsx`
- Baskets: `app/app/basket/page.tsx`, `app/app/basket/[id]/page.tsx`
- About/docs: `app/app/docs/page.tsx`
- Mode (basic/advanced) context: `app/app/_lib/mode.tsx`
- Backend tx builders: `backend/src/services/vault/index.ts` (mUSDC),
  `backend/src/services/predict/structured.ts` (dUSDC strip), `…/deepbook-strategies.ts`
- mUSDC sim settlement: `backend/src/services/sim-settlement.ts`
- Deployed package/object IDs: `DEPLOYMENT.md` + `backend/.env`
