import { Router, Request, Response, NextFunction } from "express";
import {
  snapshot,
  deposit,
  withdraw,
  borrow,
  repay,
  maxBorrow,
  CollateralKind,
  TrancheKind,
  LendingError,
} from "../services/lending";

const router = Router();

/**
 * Wrap a route handler so any `LendingError` thrown by the service layer is
 * turned into a proper 4xx response with the machine-readable code and a
 * human-readable message. Anything else falls through to Express's default
 * 500 handler.
 */
function catchLendingErrors(
  fn: (req: Request, res: Response, next: NextFunction) => any,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      return fn(req, res, next);
    } catch (err) {
      if (err instanceof LendingError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      return next(err);
    }
  };
}

/**
 * GET /api/lending
 * Pool snapshot: total deposits, borrows, utilization, borrow/supply APY,
 * LTV table for every collateral class.
 */
router.get("/", (_req: Request, res: Response) => {
  res.json(snapshot());
});

/**
 * POST /api/lending/quote
 * body: { kind: 'basket'|'tranche', tier?: 90|70|50, trancheKind?, collateralValueUsd }
 */
router.post(
  "/quote",
  catchLendingErrors((req: Request, res: Response) => {
    const { kind, tier, trancheKind, collateralValueUsd } = req.body as {
      kind: CollateralKind;
      tier?: 90 | 70 | 50;
      trancheKind?: TrancheKind;
      collateralValueUsd: number;
    };
    if (!kind || !Number.isFinite(collateralValueUsd) || collateralValueUsd <= 0) {
      return res
        .status(400)
        .json({ error: "kind and positive collateralValueUsd required" });
    }
    if (!["basket", "tranche"].includes(kind)) {
      return res
        .status(400)
        .json({ error: "kind must be 'basket' or 'tranche'" });
    }
    if (kind === "basket" && tier && ![90, 70, 50].includes(tier)) {
      return res.status(400).json({ error: "tier must be 90, 70, or 50" });
    }
    if (
      kind === "tranche" &&
      trancheKind &&
      !["senior", "mezzanine", "junior"].includes(trancheKind)
    ) {
      return res
        .status(400)
        .json({ error: "trancheKind must be senior, mezzanine, or junior" });
    }
    const q = maxBorrow({ kind, tier, trancheKind, collateralValueUsd });
    res.json({ ...q, pool: snapshot() });
  }),
);

/** POST /api/lending/lend   body: { amount } */
router.post(
  "/lend",
  catchLendingErrors((req: Request, res: Response) => {
    const amount = Number(req.body?.amount);
    res.json(deposit(amount));
  }),
);

/** POST /api/lending/withdraw   body: { amount } */
router.post(
  "/withdraw",
  catchLendingErrors((req: Request, res: Response) => {
    const amount = Number(req.body?.amount);
    res.json(withdraw(amount));
  }),
);

/** POST /api/lending/borrow   body: { amount } */
router.post(
  "/borrow",
  catchLendingErrors((req: Request, res: Response) => {
    const amount = Number(req.body?.amount);
    res.json(borrow(amount));
  }),
);

/** POST /api/lending/repay   body: { amount } */
router.post(
  "/repay",
  catchLendingErrors((req: Request, res: Response) => {
    const amount = Number(req.body?.amount);
    res.json(repay(amount));
  }),
);

export const lendingRoutes = router;
