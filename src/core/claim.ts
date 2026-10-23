import { Keypair, PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk } from "./pumpsdk.js";
import { config } from "./config.js";
import { feeOf, prepareLegacy, rpc, sendPrepared, statusOf, transferIx } from "./chain.js";
import { sql } from "./db.js";
import { addCost } from "./ledger.js";
import { errText, log } from "./log.js";

// Creator fees on pump.fun build up in a vault for the deploy wallet. Each tick:
// 1) the deploy wallet claims its vault (it pays the network fee, so pump.fun's
//    SDK also unwraps any WSOL from the pool leg back into plain SOL),
// 2) we read from the confirmed transaction exactly how much SOL the deploy
//    wallet gained after its fee,
// 3) that exact amount moves to the treasury. Only moved money is split.

export const vaultLamports = async (creator: PublicKey) => {
  const sdk = new OnlinePumpSdk(rpc());
  return BigInt((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());
};

// What left pump.fun's vaults is the sum of every balance that went down,
// other than our own two wallets. The deploy wallet's own gain is what it
// actually received after its network fee and any account rent, and that is
// the amount we move and split. Gross, rent and fee are kept for the record.
const claimedFromTx = async (signature: string, creator: PublicKey, treasury: PublicKey) => {
  const tx = await rpc().getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta) throw new Error("Claim transaction not found yet.");
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  let claimed = 0n;
  let rent = 0n;
  let creatorGain: bigint | null = null;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys.get(i);
    const delta = BigInt(tx.meta.postBalances[i] - tx.meta.preBalances[i]);
    if (key?.equals(creator)) creatorGain = delta;
    else if (key?.equals(treasury)) continue;
    else if (delta < 0n) claimed += -delta;
    else rent += delta;
  }
  if (creatorGain === null) throw new Error("Deploy wallet is not in the claim transaction.");
  return { claimed, creatorGain, rent, fee: BigInt(tx.meta.fee) };
};

const FEE_CLAIM_LOG = /CollectCreatorFee|SweepCreatorFee/;

// Fees claimed by another session of this same dev wallet never pass through our
// claim transaction, so they would sit on the dev wallet and miss the split.
const recordOutsideClaims = async (creator: PublicKey) => {
  const known = await sql()`select signature from inflows where signature is not null`;
  const seen = new Set(known.map((r) => r.signature as string));
  const sigs = await rpc().getSignaturesForAddress(creator, { limit: 40 }, "confirmed");
  let recorded = 0;
  let lamports = 0n;
  for (const s of sigs) {
    if (s.err || seen.has(s.signature)) continue;
    const tx = await rpc().getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    if (!(tx.meta.logMessages ?? []).some((line) => FEE_CLAIM_LOG.test(line))) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
    let gain: bigint | null = null;
    for (let i = 0; i < keys.length; i += 1) {
      if (keys.get(i)?.equals(creator)) gain = BigInt(tx.meta.postBalances[i] - tx.meta.preBalances[i]);
    }
    if (gain === null || gain <= 0n) continue;
    await sql()`
      insert into inflows (kind, lamports, move_lamports, signature, status, meta)
      values ('claim', ${gain}, ${gain}, ${s.signature}, 'claimed', ${sql().json({ outside: true })})
    `;
    recorded += 1;
    lamports += gain;
  }
  if (recorded) log("claim.outside", { count: recorded, lamports: lamports.toString() });
};

export const claimAndMove = async (creator: Keypair, treasury: Keypair) => {
  // Finish any claim from an earlier tick first.
  await settleInflows(creator, treasury);
  await recordOutsideClaims(creator.publicKey);
  await settleInflows(creator, treasury);

  const waiting = await vaultLamports(creator.publicKey);
  if (waiting < config.minClaimLamports) return { claimed: 0n, waiting };
  if (config.dryRun) {
    log("claim.dry_run", { waiting });
    return { claimed: 0n, waiting };
  }
  const sdk = new OnlinePumpSdk(rpc());
  const ixs = await sdk.collectCoinCreatorFeeInstructions(creator.publicKey, creator.publicKey);
  const prepared = await prepareLegacy(ixs, [creator], { units: 150_000, feePayer: creator.publicKey });
  const [row] = await sql()`
    insert into inflows (kind, lamports, signature, last_valid_height, status)
    values ('claim', 0, ${prepared.signature}, ${prepared.lastValidBlockHeight}, 'sent')
    returning id
  `;
  const state = await sendPrepared(prepared);
  log("claim.sent", { id: row.id, signature: prepared.signature, state, waiting });
  await settleInflows(creator, treasury);
  return { claimed: waiting, waiting };
};

// Moves claimed lamports to the treasury and settles claims left in flight.
export const settleInflows = async (creator: Keypair, treasury: Keypair) => {
  const rows = await sql()`select * from inflows where kind = 'claim' and status in ('sent', 'claimed', 'moving') order by id`;
  for (const row of rows) {
    try {
      if (row.status === "sent") {
        const state = await statusOf(row.signature as string, Number(row.last_valid_height));
        if (state === "pending") continue;
        if (state !== "confirmed") {
          await sql()`update inflows set status = 'failed', error = ${state} where id = ${row.id}`;
          continue;
        }
        const got = await claimedFromTx(row.signature as string, creator.publicKey, treasury.publicKey);
        const net = got.creatorGain > 0n ? got.creatorGain : 0n;
        await sql()`
          update inflows set status = 'claimed', lamports = ${net}, move_lamports = ${net},
            meta = ${sql().json({ gross: got.claimed.toString(), rent: got.rent.toString(), fee: got.fee.toString() })}
          where id = ${row.id}
        `;
        row.status = "claimed";
        row.move_lamports = net;
      }
      if (row.status === "claimed") {
        const amount = BigInt(row.move_lamports as bigint);
        if (amount <= 0n) {
          await sql()`update inflows set status = 'moved' where id = ${row.id}`;
          continue;
        }
        const prepared = await prepareLegacy([transferIx(creator.publicKey, treasury.publicKey, amount)], [treasury, creator], {
          feePayer: treasury.publicKey,
          units: 10_000,
        });
        await sql()`update inflows set status = 'moving', move_signature = ${prepared.signature}, move_valid_height = ${prepared.lastValidBlockHeight} where id = ${row.id}`;
        const state = await sendPrepared(prepared);
        if (state === "confirmed") {
          await addCost("move_fee", await feeOf(prepared.signature), prepared.signature);
          await sql()`update inflows set status = 'moved', error = null where id = ${row.id}`;
        } else if (state !== "pending") {
          await sql()`update inflows set status = 'claimed', error = ${state} where id = ${row.id}`;
        }
        continue;
      }
      if (row.status === "moving") {
        const sig = row.move_signature as string | null;
        const height = row.move_valid_height;
        if (!sig) {
          await sql()`update inflows set status = 'claimed' where id = ${row.id}`;
          continue;
        }
        const state = await statusOf(sig, Number(height));
        if (state === "confirmed") {
          await addCost("move_fee", await feeOf(sig), sig);
          await sql()`update inflows set status = 'moved', error = null where id = ${row.id}`;
        } else if (state !== "pending") {
          await sql()`update inflows set status = 'claimed', error = ${state} where id = ${row.id}`;
        }
      }
    } catch (err) {
      log("claim.settle_error", { id: row.id, error: errText(err) });
    }
  }
};
