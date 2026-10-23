import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import { ZodError } from "zod";
import { config } from "./config.js";
import { isAddress, solBalance } from "./chain.js";
import { dbReady, sql } from "./db.js";
import { walletTokenBalance } from "./holders.js";
import { liabilities, totals } from "./ledger.js";
import { liveToken } from "./launch.js";
import { AuthError, issueNonce, sessionWallet, signIn, signInMessage, signOut } from "./auth.js";
import { errText, log } from "./log.js";
import { solUsd, tokenPriceUsd } from "./price.js";
import { minRawBalance, nextSplitAt } from "./split.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const json = (res: Response, body: unknown) => res.type("application/json").send(JSON.stringify(body, (_k, v) => str(v)));

export type CoreOptions = {
  treasury: PublicKey | null;
  extraStatus?: () => Promise<Record<string, unknown>>;
};

// A light per-IP limit so nobody can drain our RPC and price quotas.
export const rateLimit = (perMinute: number) => {
  const hits = new Map<string, { at: number; n: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const row = hits.get(key);
    if (!row || now - row.at > 60_000) hits.set(key, { at: now, n: 1 });
    else if (++row.n > perMinute) {
      res.status(429).json({ error: "Too many requests. Wait a few seconds and try again." });
      return;
    }
    if (hits.size > 50_000) hits.clear();
    next();
  };
};

let statusCache: { at: number; body: unknown } | null = null;

export const createApp = (opts: CoreOptions) => {
  const app = express();
  app.set("trust proxy", true);
  app.use(cors({ origin: config.siteOrigins, credentials: false }));
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", rateLimit(240));

  app.get("/health", wrap(async (_req, res) => {
    json(res, { ok: true, db: await dbReady(), product: config.product });
  }));

  app.get("/api/status", wrap(async (_req, res) => {
    if (statusCache && Date.now() - statusCache.at < 5_000) {
      json(res, statusCache.body);
      return;
    }
    const live = await liveToken();
    const [t, last] = await Promise.all([totals(), sql()`select * from splits where source_lamports > 0 or allocated_lamports > 0 order by id desc limit 1`]);
    let price: number | null = null;
    let sol: number | null = null;
    if (live) {
      [price, sol] = await Promise.all([tokenPriceUsd(live.mint).catch(() => null), solUsd().catch(() => null)]);
    } else {
      sol = await solUsd().catch(() => null);
    }
    const treasury = opts.treasury
      ? { address: opts.treasury.toBase58(), lamports: await solBalance(opts.treasury).catch(() => null), owedLamports: await liabilities() }
      : null;
    const body = {
      product: config.product,
      ticker: config.ticker,
      live: Boolean(live),
      mint: live?.mint.toBase58() ?? null,
      launchedAt: live?.detectedAt ?? null,
      nextSplitAt: nextSplitAt(new Date(), config.splitMinutes),
      rules: {
        splitMinutes: config.splitMinutes,
        minHoldUsd: config.minHoldUsd,
        holderShareBps: config.holderShareBps,
        deductCosts: config.deductCosts,
        minSolPayoutLamports: config.minSolPayoutLamports,
      },
      priceUsd: price,
      solUsd: sol,
      lastSplit: last[0] ?? null,
      totals: t,
      treasury,
      ...(opts.extraStatus ? await opts.extraStatus() : {}),
    };
    statusCache = { at: Date.now(), body };
    json(res, body);
  }));

  app.get("/api/splits", wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const before = Number(req.query.before) || null;
    // Splits where nothing came in and nothing was split are counted but not listed.
    const rows = before
      ? await sql()`select * from splits where id < ${before} and (source_lamports > 0 or allocated_lamports > 0) order by id desc limit ${limit}`
      : await sql()`select * from splits where source_lamports > 0 or allocated_lamports > 0 order by id desc limit ${limit}`;
    const ids = rows.map((r) => Number(r.id));
    const inflows = ids.length
      ? await sql()`select split_id, kind, lamports, signature, move_signature, meta from inflows where split_id = any(${ids}::bigint[])`
      : [];
    json(res, { splits: rows.map((r) => ({ ...r, inflows: inflows.filter((i) => Number(i.split_id) === Number(r.id)) })) });
  }));

  app.get("/api/costs", wrap(async (_req, res) => {
    json(res, { costs: await sql()`select kind, lamports, signature, at from costs order by id desc limit 100` });
  }));

  app.post("/api/auth/nonce", wrap(async (req, res) => {
    const wallet = String(req.body?.wallet || "");
    if (!isAddress(wallet)) throw new HttpError(400, "That is not a Solana wallet address.");
    const nonce = await issueNonce(wallet, "signin");
    json(res, { nonce, message: signInMessage(config.product, wallet, nonce) });
  }));

  app.post("/api/auth/verify", wrap(async (req, res) => {
    const wallet = String(req.body?.wallet || "");
    if (!isAddress(wallet)) throw new HttpError(400, "That is not a Solana wallet address.");
    const token = await signIn(wallet, String(req.body?.nonce || ""), String(req.body?.signature || ""));
    json(res, { token, wallet });
  }));

  app.post("/api/auth/signout", wrap(async (req, res) => {
    await signOut(req);
    json(res, { ok: true });
  }));

  // Anyone can check a wallet's standing. Payout destinations are only shown on /api/me.
  app.get("/api/wallet/:wallet", wrap(async (req, res) => {
    const wallet = String(req.params.wallet);
    if (!isAddress(wallet)) throw new HttpError(400, "That is not a Solana wallet address.");
    json(res, await standing(wallet));
  }));

  return app;
};

export const standing = async (wallet: string) => {
  const live = await liveToken();
  const [acct] = await sql()`select owed_lamports, earned_lamports, paid_lamports from accounts where wallet = ${wallet}`;
  const recent = await sql()`
    select s.id, s.at, ss.balance, ss.lamports from split_shares ss join splits s on s.id = ss.split_id
    where ss.wallet = ${wallet} order by s.id desc limit 20
  `;
  let balance: bigint | null = null;
  let minRaw: bigint | null = null;
  let usd: number | null = null;
  if (live) {
    balance = await walletTokenBalance(new PublicKey(wallet), live.mint).catch(() => null);
    const price = await tokenPriceUsd(live.mint).catch(() => null);
    if (price && balance !== null) {
      usd = (Number(balance) / 10 ** live.decimals) * price;
      minRaw = minRawBalance(config.minHoldUsd, price, live.decimals);
    }
  }
  return {
    wallet,
    live: Boolean(live),
    balance,
    decimals: live?.decimals ?? null,
    balanceUsd: usd,
    minRaw,
    eligibleNow: minRaw !== null && balance !== null ? balance >= minRaw : null,
    owedLamports: acct ? acct.owed_lamports : 0n,
    earnedLamports: acct ? acct.earned_lamports : 0n,
    paidLamports: acct ? acct.paid_lamports : 0n,
    recentShares: recent,
  };
};

export const meWallet = sessionWallet;

export const finishApp = (app: express.Express) => {
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "The request body is not valid JSON." });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message || "Check the form and try again." });
      return;
    }
    log("http.error", { error: errText(err) });
    res.status(500).json({ error: "Something went wrong on our side. Try again in a moment." });
  });
  return app;
};
