// Runs the split engine against a real Postgres with a scripted chain.
// TEST_DATABASE_URL must point at an empty database you can drop tables in.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const url = process.env.TEST_DATABASE_URL;
const skip = !url;
if (url) {
  process.env.DATABASE_URL = url;
  process.env.MIN_HOLD_USD = "20";
  process.env.HOLDER_SHARE_BPS = "10000";
  process.env.DEDUCT_COSTS = "true";
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wallets = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
const pda = PublicKey.findProgramAddressSync([Buffer.from("pool")], new PublicKey("11111111111111111111111111111111"))[0].toBase58();

let mod: {
  sql: typeof import("./db.js").sql;
  splitOnce: typeof import("./keeper.js").splitOnce;
  reservePayout: typeof import("./payouts.js").reservePayout;
  releasePayout: typeof import("./payouts.js").releasePayout;
  confirmPayout: typeof import("./payouts.js").confirmPayout;
  addCost: typeof import("./ledger.js").addCost;
  liabilities: typeof import("./ledger.js").liabilities;
  clearLiveCache: typeof import("./launch.js").clearLiveCache;
};

before(async () => {
  if (skip) return;
  const db = await import("./db.js");
  const keeper = await import("./keeper.js");
  const payouts = await import("./payouts.js");
  const ledger = await import("./ledger.js");
  const launch = await import("./launch.js");
  mod = { sql: db.sql, splitOnce: keeper.splitOnce, ...payouts, ...ledger, clearLiveCache: launch.clearLiveCache } as typeof mod;
  const s = db.sql();
  await s`drop schema public cascade`;
  await s`create schema public`;
  const dir = process.env.MIGRATIONS_DIR || path.resolve(here, "../../../db/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await s.unsafe(readFileSync(path.join(dir, f), "utf8"));
  await s`insert into token_state (id, mint, decimals) values (1, ${Keypair.generate().publicKey.toBase58()}, 6)`;
  launch.clearLiveCache();
});

const hooks = { bringIn: async () => undefined, excluded: () => [] as string[] };
const snapOf = (rows: [string, bigint][]) => async () => ({ holdings: new Map(rows), decimals: 6, supply: 1_000_000_000_000_000n });
const prices = async () => [0.0001, 100] as [number, number];

test("first split only records a snapshot, nobody has held through yet", { skip }, async () => {
  await mod.sql()`insert into inflows (kind, lamports, status) values ('claim', 1000000000, 'moved')`;
  const out = await mod.splitOnce(hooks, {
    snapshot: snapOf([[wallets[0], 600_000_000_000n], [wallets[1], 200_000_000_000n], [pda, 900_000_000_000n]]),
    prices,
  });
  assert.equal((out as { eligible: number }).eligible, 0);
  const [carry] = await mod.sql()`select value #>> '{}' as v from kv where key = 'carry_lamports'`;
  assert.equal(carry.v, "1000000000");
});

test("second split pays holders by the smaller balance and skips pools and small wallets", { skip }, async () => {
  await mod.addCost("payout_fee", 1_000_000n, "sigX");
  await mod.sql()`insert into inflows (kind, lamports, status) values ('claim', 500000000, 'moved')`;
  const out = (await mod.splitOnce(hooks, {
    snapshot: snapOf([
      [wallets[0], 300_000_000_000n],
      [wallets[1], 200_000_000_000n],
      [wallets[2], 900_000_000_000n],
      [pda, 900_000_000_000n],
    ]),
    prices,
  })) as { pool: bigint; allocated: bigint; eligible: number };
  // pool = 0.5 SOL new + 1 SOL carried - 0.001 SOL costs
  assert.equal(out.pool, 1_499_000_000n);
  assert.equal(out.eligible, 2);
  const rows = await mod.sql()`select wallet, owed_lamports from accounts order by owed_lamports desc`;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wallet, wallets[0]);
  // 300k / 500k of the pool
  assert.equal(BigInt(rows[0].owed_lamports as bigint), (1_499_000_000n * 300n) / 500n);
  const [t] = await mod.sql()`select sum(owed_lamports)::bigint as s from accounts`;
  const [carry] = await mod.sql()`select value #>> '{}' as v from kv where key = 'carry_lamports'`;
  assert.equal(BigInt(t.s as bigint) + BigInt(carry.v as string), 1_499_000_000n);
  const [uc] = await mod.sql()`select value #>> '{}' as v from kv where key = 'unrecovered_costs'`;
  assert.equal(uc.v, "0");
});

test("a payout takes from owed, a failure gives it back, a success counts as paid", { skip }, async () => {
  const before = await mod.liabilities();
  const p = await mod.reservePayout({ wallet: wallets[0], route: "sol", dest: wallets[0], lamports: 100_000_000n });
  assert.ok(p);
  assert.equal(await mod.reservePayout({ wallet: wallets[0], route: "sol", dest: wallets[0], lamports: 1n }), null, "one payout at a time");
  assert.equal(await mod.liabilities(), before, "in-flight payouts still count as owed");
  await mod.releasePayout(p!.id, "test failure");
  const [a] = await mod.sql()`select owed_lamports from accounts where wallet = ${wallets[0]}`;
  assert.equal(BigInt(a.owed_lamports as bigint), (1_499_000_000n * 300n) / 500n);
  const q = await mod.reservePayout({ wallet: wallets[0], route: "sol", dest: wallets[0], lamports: 100_000_000n });
  await mod.confirmPayout(q!.id);
  const [b] = await mod.sql()`select owed_lamports, paid_lamports from accounts where wallet = ${wallets[0]}`;
  assert.equal(BigInt(b.paid_lamports as bigint), 100_000_000n);
  assert.equal(await mod.liabilities(), before - 100_000_000n);
  assert.equal(await mod.reservePayout({ wallet: wallets[1], route: "sol", dest: wallets[1], lamports: 10n ** 12n }), null, "never more than owed");
});

test("money in always equals money owed + carried + paid", { skip }, async () => {
  const [inflow] = await mod.sql()`select sum(lamports)::bigint as s from inflows`;
  const [rec] = await mod.sql()`select sum(costs_recovered)::bigint as s from splits`;
  const [owed] = await mod.sql()`select sum(owed_lamports)::bigint as o, sum(paid_lamports)::bigint as p from accounts`;
  const [carry] = await mod.sql()`select value #>> '{}' as v from kv where key = 'carry_lamports'`;
  assert.equal(
    BigInt(inflow.s as bigint),
    BigInt(owed.o as bigint) + BigInt(owed.p as bigint) + BigInt(carry.v as string) + BigInt(rec.s as bigint),
  );
  await mod.sql().end();
});
