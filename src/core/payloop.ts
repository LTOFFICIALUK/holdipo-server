import type { Keypair } from "@solana/web3.js";
import { config } from "./config.js";
import { withLock } from "./db.js";
import { errText, log } from "./log.js";
import { dueAccounts, payDirectSol, reservePayout, settleSentSol, treasuryHealthy, type PayoutRow } from "./payouts.js";

export type RouteChoice = { route: string; dest: string } | null;

export type PayLoopHooks = {
  treasury: Keypair;
  // Which route a wallet is paid by. Return route 'sol' for plain SOL to dest.
  routeFor: (wallet: string) => Promise<RouteChoice>;
  // Minimum owed before a route pays out.
  minFor: (route: string) => Promise<bigint>;
  // How much of what is owed to book for a route, and when to send it. Defaults: all of it, now.
  plan?: (route: string, owed: bigint) => { lamports: bigint; notBefore?: Date } | null;
  // Moves non-SOL payouts forward: sends due ones, settles ones in flight.
  settleOther?: () => Promise<void>;
};

const PAY_LOCK = 7_302;

export const payOnce = async (hooks: PayLoopHooks) => {
  await settleSentSol(["sol"]);
  if (hooks.settleOther) await hooks.settleOther();
  if (!config.payoutsEnabled || config.dryRun) return;
  const health = await treasuryHealthy(hooks.treasury.publicKey);
  if (!health.ok) return;
  const solMin = await hooks.minFor("sol");
  const due = await dueAccounts(solMin);
  const sol: PayoutRow[] = [];
  let other = 0;
  for (const acct of due) {
    const wallet = acct.wallet as string;
    const owed = BigInt(acct.owed_lamports as bigint);
    const choice = await hooks.routeFor(wallet);
    if (!choice) continue;
    const min = choice.route === "sol" ? solMin : await hooks.minFor(choice.route);
    if (owed < min) continue;
    const plan = choice.route === "sol" || !hooks.plan ? { lamports: owed } : hooks.plan(choice.route, owed);
    if (!plan || plan.lamports <= 0n) continue;
    const row = await reservePayout({ wallet, route: choice.route, dest: choice.dest, lamports: plan.lamports, notBefore: plan.notBefore });
    if (!row) continue;
    if (choice.route === "sol") sol.push(row);
    else other++;
  }
  if (sol.length) await payDirectSol(hooks.treasury, sol);
  if (other && hooks.settleOther) await hooks.settleOther();
};

export const startPayLoop = (hooks: PayLoopHooks) => {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await withLock(PAY_LOCK, () => payOnce(hooks));
    } catch (err) {
      log("payloop.error", { error: errText(err) });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 20_000);
  return () => clearInterval(timer);
};
