// Read-only health check. Moves no funds and writes nothing.
// usage: tsx src/scripts/check-live.ts [coin mint to dry-run a split on]
import { PublicKey } from "@solana/web3.js";
import { config, keypairFromEnv } from "../core/config.js";
import { isWallet, rpc, solBalance } from "../core/chain.js";
import { sql } from "../core/db.js";
import { snapshotHolders } from "../core/holders.js";
import { liabilities } from "../core/ledger.js";
import { liveToken } from "../core/launch.js";
import { solUsd, tokenPriceUsd } from "../core/price.js";
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda } from "../core/pumpsdk.js";
import { computeSplit } from "../core/split.js";

const out: string[] = [];
const ok = (m: string) => out.push(`ok    ${m}`);
const bad = (m: string) => out.push(`FIX   ${m}`);
const info = (m: string) => out.push(`      ${m}`);

const need = ["DATABASE_URL", "RPC_URL", "TREASURY_SECRET", "PRODUCT", "TICKER", "MINT_SUFFIX", "SITE_ORIGIN"];
const extra: Record<string, string[]> = { zero: ["FEE_SECRET", "WALLET_MASTER_KEY", "CREATOR_PUBKEY"], unlinked: ["CREATOR_SECRET"], holdipo: ["CREATOR_SECRET"] };
for (const k of [...need, ...(extra[config.product] ?? [])]) (process.env[k]?.trim() ? ok : bad)(`${k} ${process.env[k]?.trim() ? "is set" : "is missing"}`);

try {
  const slot = await rpc().getSlot();
  ok(`RPC answers (slot ${slot})`);
} catch (e) {
  bad(`RPC_URL does not answer: ${(e as Error).message}`);
}
try {
  const rows = await sql()`select id from schema_migrations order by id`;
  ok(`database connected, migrations: ${rows.map((r) => r.id).join(", ")}`);
} catch (e) {
  bad(`database: ${(e as Error).message}. Deploy the db service so migrations run.`);
}
try {
  ok(`SOL price $${(await solUsd()).toFixed(2)} from Jupiter`);
} catch (e) {
  bad(`Jupiter price: ${(e as Error).message}. Set JUPITER_API_KEY if this keeps failing.`);
}

const treasury = keypairFromEnv("TREASURY_SECRET");
const creator = keypairFromEnv("CREATOR_SECRET");
const creatorPub = creator?.publicKey ?? (process.env.CREATOR_PUBKEY ? new PublicKey(process.env.CREATOR_PUBKEY) : null);
if (treasury) {
  const bal = await solBalance(treasury.publicKey);
  const owed = await liabilities().catch(() => 0n);
  info(`treasury ${treasury.publicKey.toBase58()} holds ${Number(bal) / 1e9} SOL, owes holders ${Number(owed) / 1e9} SOL`);
  (bal >= owed + config.treasuryReserveLamports ? ok : bad)(
    `treasury needs at least ${Number(config.treasuryReserveLamports) / 1e9} SOL above what it owes for network fees`,
  );
}
if (creatorPub) {
  const cb = await solBalance(creatorPub);
  info(`deploy wallet ${creatorPub.toBase58()} (${Number(cb) / 1e9} SOL)`);
  if (creator) (cb >= 10_000_000n ? ok : bad)("deploy wallet keeps 0.01+ SOL to pay the claim network fee");
}
if (config.product === "unlinked" && treasury) {
  try {
    const oneclickPath = "../core/oneclick.js";
    const { quote, SOL_ASSET } = await import(oneclickPath);
    const q = await quote({ destinationAsset: SOL_ASSET, recipient: treasury.publicKey.toBase58(), lamports: 50_000_000n, refundTo: treasury.publicKey.toBase58(), dry: true });
    ok(`NEAR Intents quotes (0.05 SOL routes to ${q.amountOutFormatted} SOL)`);
  } catch (e) {
    bad(`NEAR Intents: ${(e as Error).message}`);
  }
}
if (config.product === "holdipo") {
  const { quote } = await import("../core/jupiter.js");
  for (const [name, mint] of [["OpenAI", process.env.OPENAI_MINT || "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF"], ["Anthropic", process.env.ANTHROPIC_MINT || "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw"]]) {
    try {
      const q = await quote({ inputMint: "So11111111111111111111111111111111111111112", outputMint: mint, amount: 100_000_000n, slippageBps: 300 });
      ok(`Jupiter routes SOL to ${name} PreStocks (impact ${q.priceImpactPct.toFixed(2)}%)`);
    } catch (e) {
      bad(`Jupiter cannot route SOL to ${name} PreStocks: ${(e as Error).message}`);
    }
  }
}
if (config.product === "zero") {
  try {
    const custodyPath = "../terminal/custody.js";
    const { checkMasterKey } = await import(custodyPath);
    (checkMasterKey() ? ok : bad)("WALLET_MASTER_KEY encrypts and decrypts");
    const fee = keypairFromEnv("FEE_SECRET");
    if (fee) {
      const fb = await solBalance(fee.publicKey);
      (fb >= 2_000_000n ? ok : bad)(`fee wallet ${fee.publicKey.toBase58()} holds ${Number(fb) / 1e9} SOL (needs 0.002+ so small fees can land in it)`);
    }
  } catch (e) {
    bad(`WALLET_MASTER_KEY: ${(e as Error).message}`);
  }
}
const live = await liveToken().catch(() => null);
if (config.mintSuffix && !/^[1-9A-HJ-NP-Za-km-z]+$/.test(config.mintSuffix))
  bad(`MINT_SUFFIX "${config.mintSuffix}" can never match: Solana addresses have no 0, O, I or lowercase l. Copy the exact last characters of your vanity CA.`);
info(live ? `live coin ${live.mint.toBase58()} (detected ${live.detectedAt.toISOString()})` : `not live yet: watching the deploy wallet for a coin ending in "${config.mintSuffix}"`);
info(`rules: split every ${config.splitMinutes} min, min hold $${config.minHoldUsd}, holders get ${config.holderShareBps / 100}% , costs ${config.deductCosts ? "come out of the pool" : "are covered by the fee wallet"}`);
info(`switches: splits ${config.splitsEnabled ? "on" : "OFF"}, payouts ${config.payoutsEnabled ? "on" : "OFF"}, dry run ${config.dryRun ? "ON" : "off"}`);

const mintArg = process.argv[2];
if (mintArg) {
  const mint = new PublicKey(mintArg);
  const curveInfo = await rpc().getAccountInfo(bondingCurvePda(mint));
  if (curveInfo) {
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    const waiting = await new OnlinePumpSdk(rpc()).getCreatorVaultBalanceBothPrograms(curve.creator);
    info(`pump.fun creator ${curve.creator.toBase58()}, fees waiting ${Number(waiting.toString()) / 1e9} SOL, graduated ${curve.complete}, cashback ${curve.isCashbackCoin}`);
    if (curve.isCashbackCoin) bad("this coin is a cashback coin: its creator fees do not go to the creator. Do not launch with cashback on.");
  }
  const t0 = Date.now();
  const snap = await snapshotHolders(mint);
  const price = await tokenPriceUsd(mint);
  const split = computeSplit({
    current: snap.holdings,
    previous: snap.holdings,
    excluded: new Set([treasury?.publicKey.toBase58() ?? "", creatorPub?.toBase58() ?? "", ...config.extraExcluded]),
    isWallet,
    decimals: snap.decimals,
    tokenPriceUsd: price,
    minHoldUsd: config.minHoldUsd,
    poolLamports: 1_000_000_000n,
  });
  ok(`snapshot of ${snap.holdings.size} holders in ${Date.now() - t0} ms at $${price.toPrecision(4)} per token`);
  info(`a 1 SOL split right now would go to ${split.eligible.length} wallets; top 3:`);
  for (const r of split.eligible.slice(0, 3)) info(`  ${r.wallet} ${(Number(r.lamports) / 1e9).toFixed(6)} SOL`);
}
console.log(out.join("\n"));
await sql().end({ timeout: 1 }).catch(() => undefined);
