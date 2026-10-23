import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda } from "./pumpsdk.js";
import { config } from "./config.js";
import { rpc, sleep } from "./chain.js";
import { kvGet, kvSet, sql } from "./db.js";
import { log } from "./log.js";

export type Live = { mint: PublicKey; decimals: number; createSig: string | null; detectedAt: Date };

let cached: Live | null = null;

export const liveToken = async (): Promise<Live | null> => {
  if (cached) return cached;
  const [row] = await sql()`select mint, decimals, create_sig, detected_at from token_state where id = 1`;
  if (!row) return null;
  cached = { mint: new PublicKey(row.mint as string), decimals: Number(row.decimals), createSig: (row.create_sig as string) ?? null, detectedAt: row.detected_at as Date };
  return cached;
};

export const clearLiveCache = () => {
  cached = null;
};

const save = async (mint: PublicKey, signature: string | null) => {
  const supply = await rpc().getTokenSupply(mint, "confirmed");
  await sql()`
    insert into token_state (id, mint, decimals, create_sig) values (1, ${mint.toBase58()}, ${supply.value.decimals}, ${signature})
    on conflict (id) do nothing
  `;
  cached = null;
  const live = await liveToken();
  log("launch.detected", { mint: live?.mint.toBase58(), signature });
  return live;
};

// The coin counts only if pump.fun's curve says our creator made it.
export const createdBy = async (mint: PublicKey, creator: PublicKey) => {
  const info = await rpc().getAccountInfo(bondingCurvePda(mint), "confirmed");
  if (!info) return false;
  const curve = PUMP_SDK.decodeBondingCurve(info);
  return curve.creator.equals(creator);
};

const candidates = (keys: string[]) =>
  config.mintSuffix ? keys.filter((k) => k.endsWith(config.mintSuffix)) : keys;

// Watches the deploy wallet. The first pump.fun coin it creates with the vanity
// suffix becomes the live coin. TOKEN_MINT in env skips the wait.
export const watchLaunch = async (creator: PublicKey | null, stop: () => boolean) => {
  if (await liveToken()) return liveToken();
  if (config.tokenMint) {
    const mint = new PublicKey(config.tokenMint);
    if (creator && !(await createdBy(mint, creator))) {
      throw new Error("TOKEN_MINT was not created by the deploy wallet. Check CREATOR_SECRET and TOKEN_MINT.");
    }
    return save(mint, null);
  }
  if (!creator) throw new Error("Set CREATOR_PUBKEY (or CREATOR_SECRET) or TOKEN_MINT so the listener knows what to watch.");
  log("launch.watching", { creator: creator.toBase58(), suffix: config.mintSuffix || null });
  // A fresh deploy wallet has few transactions, so the first pass reads its latest 50.
  // That also catches a coin created before this server started.
  let until = await kvGet<string | null>("launch_cursor", null);
  while (!stop()) {
    try {
      const sigs = await rpc().getSignaturesForAddress(creator, { until: until ?? undefined, limit: 50 }, "confirmed");
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        const tx = await rpc().getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        if (!tx) throw new Error(`transaction ${s.signature} not readable yet`);
        const keys = [
          ...tx.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
          ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
          ...(tx.meta?.postTokenBalances ?? []).map((b) => b.mint),
        ];
        for (const key of new Set(candidates(keys))) {
          const mint = new PublicKey(key);
          if (await createdBy(mint, creator).catch(() => false)) return save(mint, s.signature);
        }
      }
      if (sigs.length) {
        until = sigs[sigs.length - 1].signature;
        await kvSet("launch_cursor", until);
      }
    } catch (err) {
      log("launch.watch_error", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(4_000);
  }
  return null;
};
