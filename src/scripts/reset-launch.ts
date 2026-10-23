// Clears the coin and every split record so the server can watch for a new
// coin. Use it once, after testing on a test coin and before the real launch.
// usage: CONFIRM=yes tsx src/scripts/reset-launch.ts
import { config } from "../core/config.js";
import { sql } from "../core/db.js";
import { liabilities } from "../core/ledger.js";

if (process.env.CONFIRM !== "yes") {
  console.log("This deletes the live coin, all snapshots, splits, shares, payouts and owed balances. Run again with CONFIRM=yes.");
  process.exit(1);
}
const owed = await liabilities();
const [busy] = await sql()`select count(*)::int as n from payouts where status in ('planned', 'sent', 'routing', 'review')`;
if ((owed > 0n || Number(busy.n) > 0) && process.env.FORCE !== "yes") {
  console.log(`Holders are still owed ${Number(owed) / 1e9} SOL and ${busy.n} payouts are in flight. Let them pay out first, or add FORCE=yes if this was only a test.`);
  process.exit(1);
}
await sql().begin(async (tx) => {
  await tx`truncate split_shares, splits, snapshot_balances, snapshots, inflows, costs, payouts, accounts, token_state restart identity cascade`;
  await tx`delete from kv where key in ('carry_lamports', 'unrecovered_costs', 'launch_cursor')`;
  if (config.product === "zero") {
    // Test-period fees stay with the fee wallet and never reach the real coin's holders.
    await tx`update trades set fee_split_at = now() where fee_split_at is null`;
  }
});
console.log("Reset done. Restart the server: it will watch the deploy wallet in CREATOR_SECRET / CREATOR_PUBKEY for the new coin.");
await sql().end();
