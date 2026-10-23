import { PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda } from "./pumpsdk.js";
import { config } from "./config.js";
import { rpc } from "./chain.js";

export const WSOL = "So11111111111111111111111111111111111111112";

export const jupHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { accept: "application/json" };
  if (config.jupiterKey) h["x-api-key"] = config.jupiterKey;
  return h;
};

const cache = new Map<string, { at: number; usd: number }>();

export const jupiterPrices = async (mints: string[]) => {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 50) {
    const ids = mints.slice(i, i + 50).join(",");
    const res = await fetch(`${config.jupiterBase}/price/v3?ids=${ids}`, { headers: jupHeaders() });
    if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice?: number } | null>;
    for (const [mint, row] of Object.entries(body)) {
      const usd = Number(row?.usdPrice ?? 0);
      if (usd > 0) out.set(mint, usd);
    }
  }
  return out;
};

export const priceUsd = async (mint: string, maxAgeMs = 20_000) => {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.usd;
  const prices = await jupiterPrices([mint]);
  const usd = prices.get(mint);
  if (!usd) throw new Error(`No price for ${mint}.`);
  cache.set(mint, { at: Date.now(), usd });
  return usd;
};

export const solUsd = () => priceUsd(WSOL);

// Price from the pump.fun curve when Jupiter has none yet (first minutes after launch).
export const curvePriceSol = async (mint: PublicKey) => {
  const info = await rpc().getAccountInfo(bondingCurvePda(mint));
  if (!info) return null;
  const curve = PUMP_SDK.decodeBondingCurve(info);
  if (curve.complete) return null;
  const sol = Number(curve.virtualQuoteReserves.toString()) / 1e9;
  const tokens = Number(curve.virtualTokenReserves.toString()) / 1e6;
  if (!(sol > 0 && tokens > 0)) return null;
  return sol / tokens;
};

export const tokenPriceUsd = async (mint: PublicKey) => {
  try {
    return await priceUsd(mint.toBase58());
  } catch {
    const [perToken, sol] = await Promise.all([curvePriceSol(mint), solUsd()]);
    if (!perToken) throw new Error("The coin has no price yet.");
    return perToken * sol;
  }
};

export const lamportsToUsd = (lamports: bigint, solPrice: number) => (Number(lamports) / 1e9) * solPrice;

export const usdToLamports = (usd: number, solPrice: number) => BigInt(Math.ceil((usd / solPrice) * 1e9));
