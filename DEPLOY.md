# Pelagos — Deploy Runbook

Frontend (`app/`, Next.js) → **Vercel**. Backend (`backend/`, Express) → **Akash Network**.

---

## ⚠️ GATE: do not ship until the security fix lands

This deploy is **blocked** on the operator-route fix landing first. The
operator-signed routes `POST /api/predict/supply` and `POST /api/predict/withdraw`
move the operator's on-chain float and are **not yet admin-gated**. Exposing them
on public Akash ingress lets any caller drain the operator wallet. That fix is in
progress separately — **do not open global ingress to the backend until it merges.**
Everything below is the runbook to run *once that gate clears*.

---

## A) Vercel — frontend

Next.js inlines every `NEXT_PUBLIC_*` var **at build time**. If they're unset when
Vercel builds, the compiled bundle bakes in `http://localhost:13101` and the live
site's browser fetches localhost — every call fails. So set them **before building**,
for **both Production and Preview** environments.

1. In **Vercel → Project → Settings → Environment Variables**, add the following for
   **Production AND Preview** — the frontend reads only these four. It pulls all canonical on-chain
   IDs (package, coin types, object IDs) from the backend at runtime, so the package/coin vars do
   **not** need to be set in Vercel:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_BACKEND_URL` | `https://<akash-host>` (the Akash provider URI from step B, **https**) |
   | `NEXT_PUBLIC_CHAIN` | `sui` |
   | `NEXT_PUBLIC_SUI_NETWORK` | `testnet` |
   | `NEXT_PUBLIC_SUI_RPC_URL` | `https://fullnode.testnet.sui.io:443` |

   (Optional: `BACKEND_URL` = same as `NEXT_PUBLIC_BACKEND_URL` if any server-side
   route reads the non-public name.)

2. **No secrets in `vercel.json`.** It is committed and public. It carries only the
   framework/build config. Operator keys never touch the frontend.

3. Confirm a green build locally first:
   ```bash
   next build
   ```
   Fix any error before pushing. Then deploy (push to the connected branch, or
   `vercel --prod`). A Vercel build only picks up env-var changes on the **next**
   build — re-deploy after editing them.

---

## B) Akash — backend

Akash deploys **images, not Dockerfiles**. Build + push, then deploy the SDL.

1. **Build and push the image** (the SDL references `ghcr.io/tharune/pelagos-backend:latest`):
   ```bash
   docker build -t ghcr.io/tharune/pelagos-backend:latest backend/
   docker push  ghcr.io/tharune/pelagos-backend:latest
   ```
   Prefer pinning an immutable `@sha256:...` digest in `deploy/akash/deploy.yaml`
   over `:latest` so a re-push can't silently change what's running. The image must
   be **pullable by the Akash provider** (public GHCR, or configure pull creds).

2. **Fill the env block** in `deploy/akash/deploy.yaml`:
   - `SUI_PRIVATE_KEY` / `PREDICT_SIGNER_PRIVATE_KEY` → the **dedicated low-value
     operator key** (see key hygiene below).
   - `FRONTEND_URL` → your real Vercel domain (`https://<vercel-domain>`).
   - Leave `SUPABASE_URL` / `SUPABASE_ANON_KEY` empty for Sui-only mode, **or** set
     both (see the persistence note — Supabase is the durable option).

3. **Pre-fund the operator wallet** before going live. The faucet float dispenses
   per request: `SUI_GRANT_MIST` = 0.4 SUI of gas plus a dUSDC + mUSDC top-up per
   recipient. Fund **generously**:
   - SUI for gas (cover expected `0.4 SUI × claimants` + headroom), and
   - a **dUSDC float** the operator owns and transfers from.
   Underfunding makes `/api/dev` grants and Predict supply fail mid-demo.

4. **Rotate the operator key.** Treat it as compromised-by-default: it lives on a
   public box and signs txs. Use a fresh dedicated key, fund minimally, and rotate
   (move/burn residual funds, retire the key) **after the event**.

5. **Persistent state — Akash storage is ephemeral and resets on restart.** The
   backend writes runtime-state JSON next to the process:
   `backend/.distribution-pools.json`, `backend/.distribution-positions.json`,
   `backend/.sim-positions.json`. On a vanilla Akash restart these are **lost**,
   wiping distribution pools / positions / sim state. Pick one:
   - **Declare a persistent volume** in the SDL (`profiles.compute.*.resources.storage`
     with `attributes: { persistent: true, class: beta3 }`) mounted at the dir those
     files live in, **OR**
   - **Move that state to Supabase** (set `SUPABASE_URL` + `SUPABASE_ANON_KEY`) so it
     survives restarts and redeploys — the cleaner option for anything multi-session.

6. **Restart policy + liveness probe.** Configure the lease/provider to **restart on
   crash** and add a liveness probe on `GET /api/health` (returns
   `{ status: "ok" | "degraded", ... }`; in Sui-only mode it reports `degraded` only
   if `SUI_PACKAGE_ID` is unset, which it won't be here). Treat non-2xx / unreachable
   as unhealthy and restart.

7. **Deploy the SDL:**
   ```bash
   akash tx deployment create deploy/akash/deploy.yaml --from <wallet> ...
   # then: query bids → create lease → send manifest → query the provider URI
   ```
   (Or deploy `deploy/akash/deploy.yaml` via Cloudmos / Akash Console.) The provider
   URI it returns is your `<akash-host>` for step A.

8. **Single replica only.** `deployment.*.count: 1` is intentional — the in-process
   cron and the operator faucet float assume one instance. **Do not scale up:** >1
   replica double-spends the float and duplicates NAV writes.

---

## C) Wiring the two together

- **`NEXT_PUBLIC_BACKEND_URL` on Vercel must point at the Akash host over `https`**
  (the provider URI from B7). This is the single seam between the two deploys.
- **CORS is already handled.** The backend reflects any `*.vercel.app` origin (preview
  + prod), plus `localhost`/`127.0.0.1` and any explicit `FRONTEND_URL`. No backend
  CORS change is needed for a normal Vercel domain; set `FRONTEND_URL` only for a
  custom domain.
- **IDs must match on both sides.** Confirm the Sui **network**, **package ID**, and
  every **object ID** are identical in the Vercel `NEXT_PUBLIC_*` vars and the Akash
  env block (both currently `testnet`, package `0x598434be…`). A mismatch silently
  reads/writes the wrong on-chain objects.

---

## Quick checklist

- [ ] Security gate cleared: `/api/predict/supply` + `/withdraw` admin-gated
- [ ] `next build` green locally
- [ ] All `NEXT_PUBLIC_*` set on Vercel (Production **and** Preview)
- [ ] Image built + pushed to GHCR (digest-pinned)
- [ ] `deploy.yaml` env filled; `FRONTEND_URL` = real domain
- [ ] Dedicated operator key, funded (SUI + dUSDC float), rotation planned
- [ ] Persistent volume declared **or** state moved to Supabase
- [ ] Restart policy + `/api/health` liveness probe
- [ ] `count: 1` (single replica)
- [ ] `NEXT_PUBLIC_BACKEND_URL` → Akash host (https); IDs match both sides
