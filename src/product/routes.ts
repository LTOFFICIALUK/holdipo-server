import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../core/config.js";
import { feeOf, prepareVersioned, rpc, sendPrepared, statusOf } from "../core/chain.js";
import { sql } from "../core/db.js";
import { buildSwap, quote } from "../core/jupiter.js";
import { addCost } from "../core/ledger.js";
import { errText, log } from "../core/log.js";
import { confirmPayout, releasePayout } from "../core/payouts.js";
import type { RouteChoice } from "../core/payloop.js";
import { preferenceOf, type RouteDef } from "../core/prefs.js";
import { solUsd, usdToLamports, WSOL } from "../core/price.js";

// Holders pick how their share is paid, always to the wallet that holds the coin:
//  sol        SOL
//  openai     the OpenAI PreStocks token, bought with the share on Jupiter
//  anthropic  the Anthropic PreStocks token, bought the same way

export const STOCKS: Record<string, { mint: string; symbol: string; name: string }> = {
  openai: { mint: process.env.OPENAI_MINT?.trim() || "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", symbol: "OPENAI", name: "OpenAI PreStocks" },
  anthropic: { mint: process.env.ANTHROPIC_MINT?.trim() || "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw", symbol: "ANTHROPIC", name: "Anthropic PreStocks" },
};

export const routeDefs = (): RouteDef[] => [
  { id: "sol", label: "SOL", needsDest: false },
  { id: "openai", label: "OpenAI PreStocks", needsDest: false },
  { id: "anthropic", label: "Anthropic PreStocks", needsDest: false },
];

export const routeFor = async (wallet: string): Promise<RouteChoice> => {
  const pref = await preferenceOf(wallet);
  return { route: pref?.route && STOCKS[pref.route] ? pref.route : "sol", dest: wallet };
};

export const minFor = async (route: string) => {
  if (route === "sol") return config.minSolPayoutLamports;
  return usdToLamports(config.minStockUsd, await solUsd());
};

const backoff = new Map<number, number>();
const SLIPPAGE_BPS = 300;

export const settleStocks = (treasury: Keypair) => async () => {
  const rows = await sql()`
    select * from payouts where route in ('openai', 'anthropic') and status in ('planned', 'sent') and not_before <= now() order by id limit 20
  `;
  for (const p of rows) {
    const id = Number(p.id);
    if ((backoff.get(id) ?? 0) > Date.now()) continue;
    try {
      if (p.status === "planned") await buyFor(treasury, p);
      else await settle(p);
    } catch (err) {
      backoff.set(id, Date.now() + 60_000);
      log("stock.error", { id, error: errText(err) });
    }
  }
};

const buyFor = async (treasury: Keypair, p: Record<string, unknown>) => {
  const id = Number(p.id);
  if (!config.payoutsEnabled || config.dryRun) return;
  const stock = STOCKS[p.route as string];
  const owner = new PublicKey(p.dest as string);
  const mint = new PublicKey(stock.mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  const exists = Boolean(await rpc().getAccountInfo(ata, "confirmed"));
  // A first PreStocks payout opens the holder's token account. Its rent is the
  // holder's (it sits in their account) and comes out of their share.
  const rent = exists ? 0n : BigInt(await rpc().getMinimumBalanceForRentExemption(200));
  const lamports = BigInt(p.lamports as bigint);
  const spend = lamports - rent;
  if (spend <= 1_000_000n) {
    await releasePayout(id, "share too small to cover the token account");
    return;
  }
  let q;
  try {
    q = await quote({ inputMint: WSOL, outputMint: stock.mint, amount: spend, slippageBps: SLIPPAGE_BPS });
  } catch (err) {
    await releasePayout(id, `Jupiter quote: ${errText(err)}`);
    return;
  }
  const built = await buildSwap({
    payer: treasury.publicKey,
    quote: q,
    before: [createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID)],
    destinationTokenAccount: ata,
    priority: { maxLamports: 200_000, level: "medium" },
  });
  built.tx.sign([treasury]);
  const prepared = prepareVersioned(built.tx, built.lastValidBlockHeight);
  const sim = await rpc().simulateTransaction(built.tx, { sigVerify: false });
  if (sim.value.err) {
    await releasePayout(id, `swap would fail: ${JSON.stringify(sim.value.err)}`);
    return;
  }
  await sql()`
    update payouts set status = 'sent', signature = ${prepared.signature}, last_valid_height = ${prepared.lastValidBlockHeight},
      out_amount = ${q.outAmount.toString()}, out_symbol = ${stock.symbol}, cost_lamports = ${rent}, updated_at = now()
    where id = ${id}
  `;
  const state = await sendPrepared(prepared);
  log("stock.sent", { id, state, signature: prepared.signature });
  if (state !== "pending") await settle({ ...p, signature: prepared.signature, last_valid_height: prepared.lastValidBlockHeight });
};

const settle = async (p: Record<string, unknown>) => {
  const id = Number(p.id);
  const state = await statusOf(p.signature as string, Number(p.last_valid_height));
  if (state === "pending") return;
  if (state !== "confirmed") {
    await releasePayout(id, `swap ${state}`);
    return;
  }
  // Network fee only. Rent went to the holder's own token account.
  await addCost("stock_swap_fee", await feeOf(p.signature as string).catch(() => 10_000n), p.signature as string);
  const estimate = BigInt((p.cost_lamports as bigint) ?? 0n);
  if (estimate > 0n) {
    // We held back an estimate for the new token account. Give back whatever it did not use.
    const stock = STOCKS[p.route as string];
    const ata = getAssociatedTokenAddressSync(new PublicKey(stock.mint), new PublicKey(p.dest as string), true, TOKEN_2022_PROGRAM_ID);
    const info = await rpc().getAccountInfo(ata, "confirmed");
    const used = info ? BigInt(info.lamports) : estimate;
    const back = estimate > used ? estimate - used : 0n;
    if (back > 0n) {
      await sql().begin(async (tx) => {
        await tx`update payouts set lamports = lamports - ${back}, cost_lamports = ${used} where id = ${id}`;
        await tx`update accounts set owed_lamports = owed_lamports + ${back}, updated_at = now() where wallet = ${p.wallet as string}`;
      });
    }
  }
  await confirmPayout(id);
};
