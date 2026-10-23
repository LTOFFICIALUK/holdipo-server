import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { feeOf, prepareLegacy, sendPrepared, simulateLegacy, solBalance, statusOf, transferIx } from "./chain.js";
import { sql } from "./db.js";
import { addCost, liabilities } from "./ledger.js";
import { errText, log } from "./log.js";

export type PayoutRow = {
  id: number;
  wallet: string;
  route: string;
  dest: string;
  lamports: bigint;
};

// Takes money out of a holder's owed balance and books a payout for it, in one
// database transaction. Returns null if they have a payout in flight already.
export const reservePayout = async (input: {
  wallet: string;
  route: string;
  dest: string;
  lamports: bigint;
  notBefore?: Date;
}): Promise<PayoutRow | null> => {
  if (input.lamports <= 0n) return null;
  return sql().begin(async (tx) => {
    const [acct] = await tx`select owed_lamports from accounts where wallet = ${input.wallet} for update`;
    if (!acct || BigInt(acct.owed_lamports as bigint) < input.lamports) return null;
    const [busy] = await tx`
      select 1 from payouts where wallet = ${input.wallet} and status in ('planned', 'sent', 'routing', 'review') limit 1
    `;
    if (busy) return null;
    await tx`update accounts set owed_lamports = owed_lamports - ${input.lamports}, updated_at = now() where wallet = ${input.wallet}`;
    const [row] = await tx`
      insert into payouts (wallet, route, dest, lamports, not_before)
      values (${input.wallet}, ${input.route}, ${input.dest}, ${input.lamports}, ${input.notBefore ?? new Date()})
      returning id
    `;
    return { id: Number(row.id), wallet: input.wallet, route: input.route, dest: input.dest, lamports: input.lamports };
  });
};

// Puts the money back on the holder's owed balance. Used when a payout fails.
export const releasePayout = async (id: number, reason: string, creditBack?: bigint) => {
  await sql().begin(async (tx) => {
    const [p] = await tx`select wallet, lamports, status from payouts where id = ${id} for update`;
    if (!p || p.status === "confirmed" || p.status === "failed" || p.status === "refunded") return;
    const back = creditBack ?? BigInt(p.lamports as bigint);
    await tx`update payouts set status = 'failed', error = ${reason.slice(0, 300)}, updated_at = now() where id = ${id}`;
    if (back > 0n) {
      await tx`
        insert into accounts (wallet, owed_lamports) values (${p.wallet as string}, ${back})
        on conflict (wallet) do update set owed_lamports = accounts.owed_lamports + ${back}, updated_at = now()
      `;
    }
  });
};

export const confirmPayout = async (id: number, extra: { outAmount?: string; outSymbol?: string; outTx?: string; cost?: bigint } = {}) => {
  await sql().begin(async (tx) => {
    const [p] = await tx`select wallet, lamports, status from payouts where id = ${id} for update`;
    if (!p || p.status === "confirmed") return;
    await tx`
      update payouts set status = 'confirmed', out_amount = coalesce(${extra.outAmount ?? null}, out_amount),
        out_symbol = coalesce(${extra.outSymbol ?? null}, out_symbol), out_tx = coalesce(${extra.outTx ?? null}, out_tx),
        cost_lamports = cost_lamports + ${extra.cost ?? 0n}, error = null, updated_at = now()
      where id = ${id}
    `;
    await tx`update accounts set paid_lamports = paid_lamports + ${BigInt(p.lamports as bigint)}, updated_at = now() where wallet = ${p.wallet as string}`;
  });
};

// The treasury must always hold what it owes plus a reserve for network fees.
export const treasuryHealthy = async (treasury: PublicKey) => {
  const [balance, owed] = await Promise.all([solBalance(treasury), liabilities()]);
  const ok = balance >= owed + config.treasuryReserveLamports;
  if (!ok && owed > 0n) log("treasury.short", { balance, owed, reserve: config.treasuryReserveLamports });
  return { ok, balance, owed };
};

const BATCH = 15;
const badDest = new Map<string, number>();

// Plain SOL transfers from the treasury, up to 15 holders per transaction.
// Each batch is simulated first. A batch that would fail is split so one bad
// address never blocks everyone else, and nothing doomed is ever sent.
export const payDirectSol = async (treasury: Keypair, rows: PayoutRow[]) => {
  const ready: PayoutRow[] = [];
  for (const r of rows) {
    if ((badDest.get(r.dest) ?? 0) > Date.now()) await releasePayout(r.id, "address could not receive SOL, retrying later");
    else ready.push(r);
  }
  for (let i = 0; i < ready.length; i += BATCH) await payBatch(treasury, ready.slice(i, i + BATCH));
};

const payBatch = async (treasury: Keypair, batch: PayoutRow[]): Promise<void> => {
  const ids = batch.map((r) => r.id);
  try {
    const prepared = await prepareLegacy(
      batch.map((r) => transferIx(treasury.publicKey, new PublicKey(r.dest), r.lamports)),
      [treasury],
      { units: 5_000 + 1_000 * batch.length },
    );
    const simErr = await simulateLegacy(prepared);
    if (simErr) {
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await payBatch(treasury, batch.slice(0, half));
        await payBatch(treasury, batch.slice(half));
        return;
      }
      badDest.set(batch[0].dest, Date.now() + 60 * 60_000);
      await releasePayout(batch[0].id, `would fail: ${simErr}`);
      log("payout.sol_sim_fail", { wallet: batch[0].wallet, error: simErr });
      return;
    }
    await sql()`
      update payouts set status = 'sent', signature = ${prepared.signature}, last_valid_height = ${prepared.lastValidBlockHeight},
        batch_id = ${prepared.signature}, updated_at = now()
      where id = any(${ids}::bigint[])
    `;
    const state = await sendPrepared(prepared);
    if (state === "confirmed") {
      const fee = await feeOf(prepared.signature).catch(() => 5_000n);
      await addCost("payout_fee", fee, prepared.signature);
      for (const r of batch) await confirmPayout(r.id);
      log("payout.sol_batch", { count: batch.length, signature: prepared.signature });
    } else if (state !== "pending") {
      for (const r of batch) await releasePayout(r.id, `transfer ${state}`);
    }
  } catch (err) {
    log("payout.sol_batch_error", { error: errText(err) });
    for (const r of batch) {
      const [p] = await sql()`select status from payouts where id = ${r.id}`;
      if (p?.status === "planned") await releasePayout(r.id, errText(err));
    }
  }
};

// Finishes SOL batches left 'sent' by a restart.
export const settleSentSol = async (routes: string[]) => {
  const rows = await sql()`
    select distinct signature, last_valid_height from payouts
    where status = 'sent' and route = any(${routes}::text[]) and signature is not null
  `;
  for (const r of rows) {
    const state = await statusOf(r.signature as string, Number(r.last_valid_height)).catch(() => "pending" as const);
    if (state === "pending") continue;
    const ids = await sql()`select id from payouts where signature = ${r.signature as string} and status = 'sent'`;
    if (state === "confirmed") {
      await addCost("payout_fee", await feeOf(r.signature as string).catch(() => 5_000n), r.signature as string);
      for (const p of ids) await confirmPayout(Number(p.id));
    } else {
      for (const p of ids) await releasePayout(Number(p.id), `transfer ${state}`);
    }
  }
  // A 'planned' row older than 10 minutes never got a signature: give the money back.
  const stale = await sql()`
    select id from payouts where status = 'planned' and route = any(${routes}::text[]) and signature is null
      and not_before < now() - interval '10 minutes' and updated_at < now() - interval '10 minutes'
  `;
  for (const p of stale) await releasePayout(Number(p.id), "never sent");
};

export const dueAccounts = async (minLamports: bigint) =>
  sql()`
    select a.wallet, a.owed_lamports from accounts a
    where a.owed_lamports >= ${minLamports}
      and not exists (select 1 from payouts p where p.wallet = a.wallet and p.status in ('planned', 'sent', 'routing', 'review'))
    order by a.owed_lamports desc
    limit 300
  `;
