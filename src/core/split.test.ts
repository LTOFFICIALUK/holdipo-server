import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSplit, heldThrough, minRawBalance, nextSplitAt, poolFor, roundedRoute } from "./split.js";

const yes = () => true;
const m = (rows: [string, bigint][]) => new Map(rows);

test("min balance for $20 at $0.0001 with 6 decimals is 200k tokens", () => {
  assert.equal(minRawBalance(20, 0.0001, 6), 200_000_000_000n);
  assert.equal(minRawBalance(20, 0, 6), null);
  assert.equal(minRawBalance(0, 0, 6), 1n);
});

test("held balance is the smaller of the last two, new wallets get nothing", () => {
  const held = heldThrough(m([["a", 100n], ["b", 50n], ["c", 10n]]), m([["a", 40n], ["b", 80n]]));
  assert.equal(held.get("a"), 40n);
  assert.equal(held.get("b"), 50n);
  assert.equal(held.has("c"), false);
  assert.equal(heldThrough(m([["a", 1n]]), null).size, 0);
});

test("pool splits by held balance and never allocates more than the pool", () => {
  const r = computeSplit({
    current: m([["a", 300n], ["b", 100n], ["pool", 1000n], ["small", 1n]]),
    previous: m([["a", 300n], ["b", 100n], ["pool", 1000n], ["small", 1n]]),
    excluded: new Set(["pool"]),
    isWallet: yes,
    decimals: 0,
    tokenPriceUsd: 1,
    minHoldUsd: 20,
    poolLamports: 1_000_001n,
  });
  assert.deepEqual(r.eligible.map((x) => [x.wallet, x.lamports]), [["a", 750_000n], ["b", 250_000n]]);
  assert.equal(r.allocated + r.carry, 1_000_001n);
  assert.equal(r.carry, 1n);
});

test("off-curve owners never count", () => {
  const r = computeSplit({
    current: m([["a", 100n], ["pda", 100n]]),
    previous: m([["a", 100n], ["pda", 100n]]),
    excluded: new Set(),
    isWallet: (w) => w !== "pda",
    decimals: 0,
    tokenPriceUsd: 1,
    minHoldUsd: 20,
    poolLamports: 1000n,
  });
  assert.deepEqual(r.eligible.map((x) => x.wallet), ["a"]);
  assert.equal(r.allocated, 1000n);
});

test("no eligible holders carries the whole pool", () => {
  const r = computeSplit({
    current: m([["a", 1n]]),
    previous: m([["a", 1n]]),
    excluded: new Set(),
    isWallet: yes,
    decimals: 0,
    tokenPriceUsd: 1,
    minHoldUsd: 20,
    poolLamports: 5000n,
  });
  assert.equal(r.eligible.length, 0);
  assert.equal(r.carry, 5000n);
});

test("costs come out of the pool and the rest stays owed to recover later", () => {
  assert.deepEqual(poolFor({ sourceLamports: 1000n, holderShareBps: 5000, carryLamports: 10n, unrecoveredCosts: 600n, deductCosts: true }), {
    holderShare: 500n,
    pool: 0n,
    recovered: 510n,
    stillUnrecovered: 90n,
  });
  assert.deepEqual(poolFor({ sourceLamports: 1000n, holderShareBps: 10000, carryLamports: 0n, unrecoveredCosts: 600n, deductCosts: false }), {
    holderShare: 1000n,
    pool: 1000n,
    recovered: 0n,
    stillUnrecovered: 600n,
  });
});

test("routed payouts round down to the step", () => {
  assert.equal(roundedRoute(57_000_000n, 5_000_000n), 55_000_000n);
  assert.equal(roundedRoute(4_000_000n, 5_000_000n), 0n);
});

test("next split lands on the next 10 minute mark", () => {
  assert.equal(nextSplitAt(new Date("2026-10-23T10:03:20Z"), 10).toISOString(), "2026-10-23T10:10:00.000Z");
  assert.equal(nextSplitAt(new Date("2026-10-23T10:10:00Z"), 10).toISOString(), "2026-10-23T10:20:00.000Z");
});
