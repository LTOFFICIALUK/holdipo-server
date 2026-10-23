import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const text = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

const int = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
};

const num = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return n;
};

const flag = (name: string, fallback: boolean) => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
};

// Secret keys are read from env only. Accepts base58 or a JSON byte array.
export const keypairFromEnv = (name: string): Keypair | null => {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new Error(`${name} is not a valid Solana secret key.`);
  }
};

export const config = {
  product: text("PRODUCT", "kit"),
  port: int("PORT", 8080, 1, 65535),
  databaseUrl: text("DATABASE_URL"),
  rpcUrl: text("RPC_URL"),
  siteOrigins: text("SITE_ORIGIN", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Launch
  tokenMint: text("TOKEN_MINT"),
  mintSuffix: text("MINT_SUFFIX"),
  ticker: text("TICKER", "$TOKEN"),

  // Split rules
  splitMinutes: int("SPLIT_MINUTES", 10, 1, 1440),
  minHoldUsd: num("MIN_HOLD_USD", 20, 0, 1_000_000),
  holderShareBps: int("HOLDER_SHARE_BPS", 10_000, 0, 10_000),
  deductCosts: flag("DEDUCT_COSTS", true),
  minClaimLamports: BigInt(int("MIN_CLAIM_LAMPORTS", 5_000_000, 0, 1_000_000_000)),
  treasuryReserveLamports: BigInt(int("TREASURY_RESERVE_LAMPORTS", 20_000_000, 0, 10_000_000_000)),
  extraExcluded: text("EXCLUDE_WALLETS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Payout thresholds
  minSolPayoutLamports: BigInt(int("MIN_SOL_PAYOUT_LAMPORTS", 1_000_000, 900_000, 1_000_000_000)),
  minRoutedUsd: num("MIN_ROUTED_USD", 5, 1, 10_000),
  minZecUsd: num("MIN_ZEC_USD", 10, 2, 10_000),
  minStockUsd: num("MIN_STOCK_USD", 10, 1, 10_000),

  // Switches
  splitsEnabled: flag("SPLITS_ENABLED", true),
  payoutsEnabled: flag("PAYOUTS_ENABLED", true),
  dryRun: flag("DRY_RUN", false),

  // Services
  jupiterBase: text("JUPITER_API_URL", "https://lite-api.jup.ag").replace(/\/+$/, ""),
  jupiterKey: text("JUPITER_API_KEY"),
  oneClickBase: text("ONECLICK_BASE_URL", "https://1click.chaindefuser.com").replace(/\/+$/, ""),
  oneClickJwt: text("ONECLICK_JWT"),
  referral: text("APP_REFERRAL", "kit"),
};

export const requireRpc = () => {
  if (!config.rpcUrl) throw new Error("RPC_URL is required.");
  return config.rpcUrl;
};
