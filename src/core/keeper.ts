import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { isWallet } from "./chain.js";
import { sql, withLock } from "./db.js";
import { snapshotHolders } from "./holders.js";
import { readCounter } from "./ledger.js";
import { liveToken } from "./launch.js";
import { errText, log } from "./log.js";
import { solUsd, tokenPriceUsd } from "./price.js";
import { computeSplit, minRawBalance, nextSplitAt, poolFor } from "./split.js";

export type KeeperHooks = {
  // Brings new money into the treasury and records it in inflows as 'moved'.
  bringIn: () => Promise<void>;
  excluded: () => string[];
};

const loadSnapshot = async (id: number) => {
  const rows = await sql()`select wallet, amount::text as amount from snapshot_balances where snapshot_id = ${id}`;
  return new Map(rows.map((r) => [r.wallet as string, BigInt(r.amount as string)]));
};

const saveSnapshot = async (holdings: Map<string, bigint>, tokenPrice: number | null, sol: number | null) => {
  const db = sql();
  const [snap] = await db`
    insert into snapshots (token_price_usd, sol_usd, holder_count) values (${tokenPrice}, ${sol}, ${holdings.size}) returning id
  `;
  const wallets = [...holdings.keys()];
  const amounts = wallets.map((w) => holdings.get(w)!.toString());
  for (let i = 0; i < wallets.length; i += 5000) {
    await db`
      insert into snapshot_balances (snapshot_id, wallet, amount)
      select ${snap.id}, w, a::numeric from unnest(${wallets.slice(i, i + 5000)}::text[], ${amounts.slice(i, i + 5000)}::text[]) as t(w, a)
    `;
  }
  return Number(snap.id);
};

export type KeeperDeps = {
  snapshot: typeof snapshotHolders;
  prices: (mint: PublicKey) => Promise<[number, number]>;
};

const defaultDeps: KeeperDeps = {
  snapshot: snapshotHolders,
  prices: (mint) => Promise.all([tokenPriceUsd(mint), solUsd()]),
};

export const splitOnce = async (hooks: KeeperHooks, deps: KeeperDeps = defaultDeps) => {
  const live = await liveToken();
  if (!live) return { skipped: "not live" };

  try {
    await hooks.bringIn();
  } catch (err) {
    log("split.bring_in_error", { error: errText(err) });
  }

  const snap = await deps.snapshot(live.mint);
  let tokenPrice: number | null = null;
  let sol: number | null = null;
  try {
    [tokenPrice, sol] = await deps.prices(live.mint);
  } catch (err) {
    log("split.price_error", { error: errText(err) });
  }
  const [prev] = await sql()`select id from snapshots order by id desc limit 1`;
  const snapshotId = await saveSnapshot(snap.holdings, tokenPrice, sol);
  const previous = prev ? await loadSnapshot(Number(prev.id)) : null;

  if (tokenPrice === null || sol === null) {
    log("split.skipped", { reason: "no price", snapshotId });
    return { skipped: "no price" };
  }
  if (!config.splitsEnabled) return { skipped: "splits disabled" };

  const excluded = new Set([...hooks.excluded(), ...config.extraExcluded]);
  const db = sql();
  const result = await db.begin(async (tx) => {
    const inflows = await tx`select id, lamports::text as lamports from inflows where status = 'moved' and split_id is null for update`;
    const source = inflows.reduce((sum, r) => sum + BigInt(r.lamports as string), 0n);
    const [carryRow] = await tx`select value #>> '{}' as v from kv where key = 'carry_lamports' for update`;
    const carry = carryRow?.v ? BigInt(carryRow.v as string) : 0n;
    const unrecovered = await readCounter("unrecovered_costs");
    const pool = poolFor({
      sourceLamports: source,
      holderShareBps: config.holderShareBps,
      carryLamports: carry,
      unrecoveredCosts: unrecovered,
      deductCosts: config.deductCosts,
    });
    const split = computeSplit({
      current: snap.holdings,
      previous,
      excluded,
      isWallet,
      decimals: snap.decimals,
      tokenPriceUsd: tokenPrice!,
      minHoldUsd: config.minHoldUsd,
      poolLamports: pool.pool,
    });
    const [row] = await tx`
      insert into splits (snapshot_id, prev_snapshot_id, source_lamports, holder_share_lamports, carry_in, costs_recovered,
        pool_lamports, allocated_lamports, carry_out, eligible_count, eligible_tokens, min_raw, token_price_usd, sol_usd)
      values (${snapshotId}, ${prev ? Number(prev.id) : null}, ${source}, ${pool.holderShare}, ${carry}, ${pool.recovered},
        ${pool.pool}, ${split.allocated}, ${split.carry}, ${split.eligible.length}, ${split.eligibleTokens.toString()},
        ${minRawBalance(config.minHoldUsd, tokenPrice!, snap.decimals)?.toString() ?? null}, ${tokenPrice}, ${sol})
      returning id
    `;
    const splitId = Number(row.id);
    const paid = split.eligible.filter((s) => s.lamports > 0n);
    if (paid.length) {
      const w = paid.map((s) => s.wallet);
      const b = paid.map((s) => s.balance.toString());
      const l = paid.map((s) => s.lamports.toString());
      await tx`
        insert into split_shares (split_id, wallet, balance, lamports)
        select ${splitId}, w, b::numeric, l::bigint from unnest(${w}::text[], ${b}::text[], ${l}::text[]) as t(w, b, l)
      `;
      await tx`
        insert into accounts (wallet, owed_lamports, earned_lamports)
        select w, l::bigint, l::bigint from unnest(${w}::text[], ${l}::text[]) as t(w, l)
        on conflict (wallet) do update set
          owed_lamports = accounts.owed_lamports + excluded.owed_lamports,
          earned_lamports = accounts.earned_lamports + excluded.earned_lamports,
          updated_at = now()
      `;
    }
    if (inflows.length) {
      await tx`update inflows set split_id = ${splitId} where id = any(${inflows.map((r) => Number(r.id))}::bigint[])`;
    }
    await tx`
      insert into kv (key, value) values ('carry_lamports', ${tx.json(split.carry.toString())})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    if (pool.recovered > 0n) {
      await tx`
        update kv set value = to_jsonb(((value #>> '{}')::numeric - ${pool.recovered.toString()}::numeric)::text), updated_at = now()
        where key = 'unrecovered_costs'
      `;
    }
    return { splitId, source, pool: pool.pool, allocated: split.allocated, eligible: paid.length, carry: split.carry };
  });
  log("split.done", result);
  await sql()`delete from snapshots where taken_at < now() - interval '6 hours' and id <> ${snapshotId}`;
  return result;
};

const SPLIT_LOCK = 7_301;

export const startKeeper = (hooks: KeeperHooks) => {
  let running = false;
  let lastMark = 0;
  const tick = async () => {
    const mark = nextSplitAt(new Date(Date.now() - config.splitMinutes * 60_000), config.splitMinutes).getTime();
    if (mark === lastMark || running) return;
    running = true;
    try {
      const out = await withLock(SPLIT_LOCK, async () => {
        const [last] = await sql()`select at from splits order by id desc limit 1`;
        const [lastSnap] = await sql()`select taken_at from snapshots order by id desc limit 1`;
        const latest = Math.max(last ? new Date(last.at as Date).getTime() : 0, lastSnap ? new Date(lastSnap.taken_at as Date).getTime() : 0);
        if (latest >= mark) return { skipped: "already ran" };
        return splitOnce(hooks);
      });
      if (out.ran) lastMark = mark;
    } catch (err) {
      log("split.error", { error: errText(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 15_000);
  void tick();
  return () => clearInterval(timer);
};

export const excludedBase = (...keys: (PublicKey | null | undefined)[]) =>
  keys.filter((k): k is PublicKey => Boolean(k)).map((k) => k.toBase58());
